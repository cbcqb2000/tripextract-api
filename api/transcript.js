/**
 * TripExtract — Transcript API
 * Vercel serverless function: GET /api/transcript?v=VIDEO_ID
 */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const videoId = req.query.v || req.query.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Invalid or missing video ID (?v=VIDEO_ID)" });
  }

  const errors = [];

  // Approach 1: Innertube get_transcript API
  // Server-side we can set Origin: https://www.youtube.com — impossible from a browser
  // extension. This is the key that makes this work where the extension can't.
  try {
    const transcript = await fetchViaInnertube(videoId);
    return res.status(200).json({ transcript, videoId, via: "innertube" });
  } catch (e) {
    errors.push("innertube: " + e.message);
  }

  // Approach 2: Page scraping with consent cookies + caption URL fetch
  try {
    const transcript = await fetchViaScraping(videoId);
    return res.status(200).json({ transcript, videoId, via: "scraping" });
  } catch (e) {
    errors.push("scraping: " + e.message);
  }

  return res.status(500).json({ error: errors.join(" | ") });
};

// ─── Shared constants ─────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CLIENT_VERSION = "2.20240101";

// ─── Approach 1: Innertube API ────────────────────────────────────────────────

async function fetchViaInnertube(videoId) {
  // Encode video ID as protobuf: field 1, wire type 2 (length-delimited string)
  const params = Buffer.from(
    "\x0a" + String.fromCharCode(videoId.length) + videoId,
    "binary"
  ).toString("base64url"); // base64url = URL-safe, no padding

  const resp = await fetch("https://www.youtube.com/youtubei/v1/get_transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "Origin": "https://www.youtube.com",         // ← only settable server-side
      "Referer": `https://www.youtube.com/watch?v=${videoId}`,
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": CLIENT_VERSION,
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": "CONSENT=YES+cb; SOCS=CAESEwgDEgk0ODA0Nzg2MjIaAmVuIAEaBgiA_LyaBg",
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "WEB",
          clientVersion: CLIENT_VERSION,
          hl: "en",
          gl: "US",
          originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
          userAgent: UA,
        },
      },
      params,
    }),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const data = await resp.json();

  const segments =
    data?.actions?.[0]?.updateEngagementPanelAction?.content
      ?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer
      ?.initialSegments || [];

  if (!segments.length) {
    const topKeys = Object.keys(data || {}).slice(0, 6).join(",");
    throw new Error(`no segments (response keys: ${topKeys || "none"})`);
  }

  const transcript = segments
    .map(
      (s) =>
        s?.transcriptSegmentRenderer?.snippet?.runs?.map((r) => r.text).join("") || ""
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (transcript.length < 50) throw new Error("transcript too short");
  return transcript;
}

// ─── Approach 2: Page scrape → caption URL ────────────────────────────────────

async function fetchViaScraping(videoId) {
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://www.google.com/",
      // Consent cookies prevent YouTube from serving a stripped consent-gate page
      "Cookie": "CONSENT=YES+cb; SOCS=CAESEwgDEgk0ODA0Nzg2MjIaAmVuIAEaBgiA_LyaBg",
    },
  });

  if (!pageResp.ok) throw new Error(`page fetch ${pageResp.status}`);

  const html = await pageResp.text();

  if (!html.includes("ytInitialPlayerResponse")) {
    throw new Error(
      `no player data in page (len=${html.length}, consent_wall=${html.includes("consent")})`
    );
  }

  const pr = extractJson(html, "ytInitialPlayerResponse");
  if (!pr) throw new Error("extractJson returned null");

  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) {
    throw new Error(
      `no caption tracks (playerResponse keys: ${Object.keys(pr || {}).slice(0, 8).join(",")})`
    );
  }

  const track =
    tracks.find((t) => t.languageCode === "en" && !t.kind) ||
    tracks.find((t) => t.languageCode === "en") ||
    tracks.find((t) => t.languageCode?.startsWith("en")) ||
    tracks[0];

  if (!track?.baseUrl) throw new Error("no baseUrl on selected track");

  const base = track.baseUrl.startsWith("http")
    ? track.baseUrl
    : "https://www.youtube.com" + track.baseUrl;

  const urls = (() => {
    try {
      const u = new URL(base);
      u.searchParams.set("fmt", "json3");
      return [u.toString(), base];
    } catch {
      return [base + "&fmt=json3", base];
    }
  })();

  for (const url of urls) {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `https://www.youtube.com/watch?v=${videoId}`,
        "Origin": "https://www.youtube.com",
      },
    });
    const text = await r.text();
    if (!r.ok || !text.trim()) continue;

    if (text.trim().startsWith("{")) {
      try {
        const t = parseEvents(JSON.parse(text)?.events);
        if (t) return t;
      } catch {}
    }
    if (text.includes("<text")) {
      const t = parseXML(text);
      if (t) return t;
    }
    if (text.startsWith("WEBVTT")) {
      const t = parseVTT(text);
      if (t) return t;
    }
  }

  throw new Error("caption URLs returned no usable content");
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseEvents(events) {
  if (!events) return null;
  const text = events
    .filter((e) => e.segs)
    .map((e) =>
      e.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim()
    )
    .filter((l) => l.length > 0 && l !== "\u200b")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 50 ? text : null;
}

function parseXML(xml) {
  const parts = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n/g, " ")
      .trim();
    if (t) parts.push(t);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 50 ? joined : null;
}

function parseVTT(vtt) {
  const parts = [];
  let prev = "";
  for (const line of vtt.split("\n")) {
    const l = line.trim().replace(/<[^>]+>/g, "");
    if (!l || l.startsWith("WEBVTT") || l.includes("-->") || /^\d+$/.test(l)) continue;
    if (l !== prev) { parts.push(l); prev = l; }
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 50 ? joined : null;
}

// ─── JSON extractor (bracket-counting, handles 500KB+ blobs) ─────────────────

function extractJson(html, varName) {
  const idx = html.indexOf(varName);
  if (idx === -1) return null;
  let i = idx + varName.length;
  while (i < html.length && " \t\r\n".includes(html[i])) i++;
  if (html[i] !== "=") return null;
  i++;
  while (i < html.length && " \t\r\n".includes(html[i])) i++;
  if (html[i] !== "{") return null;
  const start = i;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (esc) { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      if (--depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
