/**
 * TripExtract — Transcript API
 * Vercel serverless function
 *
 * Two modes:
 *
 * 1. URL-proxy mode (primary):
 *    GET /api/transcript?v=VIDEO_ID&url=SIGNED_CAPTION_URL
 *    The Chrome extension extracts the signed timedtext URL from the YouTube
 *    page (it has the user's cookies so YouTube gives it the URL), then sends
 *    it here. We fetch that URL server-side — no Sec-Fetch-*, no X-Client-Data,
 *    no extension Origin. YouTube returns the content.
 *
 * 2. Direct mode (fallback):
 *    GET /api/transcript?v=VIDEO_ID
 *    Tries Innertube API, then page scraping.
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

  // ── Mode 1: URL-proxy ──────────────────────────────────────────────────────
  if (req.query.url) {
    let captionUrl;
    try { captionUrl = decodeURIComponent(req.query.url); }
    catch { return res.status(400).json({ error: "Could not decode url parameter" }); }

    if (!captionUrl.startsWith("https://www.youtube.com/api/timedtext")) {
      return res.status(400).json({ error: "url must be a YouTube timedtext URL" });
    }

    try {
      const transcript = await fetchCaptionUrl(captionUrl, videoId);
      return res.status(200).json({ transcript, videoId, via: "url-proxy" });
    } catch (e) {
      console.error(`[TripExtract] url-proxy failed for ${videoId}:`, e.message);
      return res.status(500).json({ error: "url-proxy: " + e.message });
    }
  }

  // ── Mode 2: Direct (no URL from extension) ─────────────────────────────────
  const errors = [];

  try {
    const transcript = await fetchViaInnertube(videoId);
    return res.status(200).json({ transcript, videoId, via: "innertube" });
  } catch (e) { errors.push("innertube: " + e.message); }

  try {
    const transcript = await fetchViaScraping(videoId);
    return res.status(200).json({ transcript, videoId, via: "scraping" });
  } catch (e) { errors.push("scraping: " + e.message); }

  return res.status(500).json({ error: errors.join(" | ") });
};

// ─── Shared constants ─────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CLIENT_VERSION = "2.20240101";

// ─── URL-proxy fetch ──────────────────────────────────────────────────────────

async function fetchCaptionUrl(baseUrl, videoId) {
  // Try JSON3 format first, then the original signed URL (XML/TTML)
  const urls = (() => {
    try {
      const u = new URL(baseUrl);
      u.searchParams.set("fmt", "json3");
      return [u.toString(), baseUrl];
    } catch { return [baseUrl + "&fmt=json3", baseUrl]; }
  })();

  const log = [];

  for (const url of urls) {
    const fmt = url.includes("fmt=json3") ? "json3" : "orig";
    try {
      // NOTE: No "Origin" header — setting Origin from a server IP while
      // spoofing youtube.com triggers YouTube's CSRF / forgery detection.
      // Referer alone is sufficient to identify the referencing page.
      const r = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": `https://www.youtube.com/watch?v=${videoId}`,
        },
      });
      const text = await r.text();
      const preview = JSON.stringify(text.slice(0, 80));
      log.push(`${fmt}:${r.status}:len=${text.length}:${preview}`);
      console.log(`[TripExtract] caption ${fmt}: status=${r.status} len=${text.length} preview=${preview}`);

      if (!r.ok || !text.trim()) continue;

      // JSON3 format ({"events":[{"segs":[{"utf8":"..."}]}]})
      if (text.trim().startsWith("{")) {
        try {
          const data = JSON.parse(text);
          const evts = data?.events || [];
          log.push(`json:events=${evts.length}:with-segs=${evts.filter(e => e.segs).length}`);
          const t = parseEvents(evts);
          if (t) return t;
        } catch (e) { log.push(`json-parse-err:${e.message}`); }
      }

      // Standard YouTube XML (timedtext format with <text> tags)
      if (text.includes("<text")) {
        const t = parseXML(text);
        if (t) return t;
        log.push("xml:<text>-parse-failed");
      }

      // TTML format (W3C standard, uses <p> tags)
      if (text.includes("<p ") || text.includes("<p>")) {
        const t = parseTTML(text);
        if (t) return t;
        log.push("ttml:<p>-parse-failed");
      }

      // WebVTT format
      if (text.startsWith("WEBVTT")) {
        const t = parseVTT(text);
        if (t) return t;
        log.push("vtt-parse-failed");
      }

      // SRV3 / any XML with text-like content
      if (text.includes("<?xml") || text.includes("<transcript")) {
        const t = parseGenericXML(text);
        if (t) return t;
        log.push("generic-xml-failed");
      }

    } catch (e) {
      log.push(`${fmt}:fetch-err:${e.message}`);
    }
  }

  throw new Error("no usable content [" + log.join(" || ") + "]");
}

// ─── Innertube API ────────────────────────────────────────────────────────────

async function fetchViaInnertube(videoId) {
  const params = Buffer.from(
    "\x0a" + String.fromCharCode(videoId.length) + videoId,
    "binary"
  ).toString("base64url");

  const resp = await fetch("https://www.youtube.com/youtubei/v1/get_transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "Origin": "https://www.youtube.com",
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
    throw new Error(`no segments (keys: ${Object.keys(data || {}).slice(0, 5).join(",")})`);
  }

  const transcript = segments
    .map((s) =>
      s?.transcriptSegmentRenderer?.snippet?.runs?.map((r) => r.text).join("") || ""
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (transcript.length < 50) throw new Error("transcript too short");
  return transcript;
}

// ─── Page scraping ────────────────────────────────────────────────────────────

async function fetchViaScraping(videoId) {
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://www.google.com/",
      "Cookie": "CONSENT=YES+cb; SOCS=CAESEwgDEgk0ODA0Nzg2MjIaAmVuIAEaBgiA_LyaBg",
    },
  });
  if (!pageResp.ok) throw new Error(`page ${pageResp.status}`);
  const html = await pageResp.text();
  if (!html.includes("ytInitialPlayerResponse"))
    throw new Error(`no player data (len=${html.length})`);

  const pr = extractJson(html, "ytInitialPlayerResponse");
  if (!pr) throw new Error("extractJson null");

  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length)
    throw new Error(`no tracks (keys: ${Object.keys(pr || {}).slice(0, 6).join(",")})`);

  const track =
    tracks.find((t) => t.languageCode === "en" && !t.kind) ||
    tracks.find((t) => t.languageCode === "en") ||
    tracks.find((t) => t.languageCode?.startsWith("en")) ||
    tracks[0];
  if (!track?.baseUrl) throw new Error("no baseUrl");

  return fetchCaptionUrl(
    track.baseUrl.startsWith("http")
      ? track.baseUrl
      : "https://www.youtube.com" + track.baseUrl,
    videoId
  );
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseEvents(events) {
  if (!events) return null;
  const text = events
    .filter((e) => e.segs)
    .map((e) => e.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim())
    .filter((l) => l.length > 0 && l !== "\u200b")
    .join(" ").replace(/\s+/g, " ").trim();
  return text.length > 50 ? text : null;
}

function parseXML(xml) {
  const parts = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, " ").trim();
    if (t) parts.push(t);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 50 ? joined : null;
}

function parseTTML(ttml) {
  // W3C TTML / EBU-TT format — uses <p> tags for caption segments
  const parts = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(ttml)) !== null) {
    const t = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, " ").trim();
    if (t) parts.push(t);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 50 ? joined : null;
}

function parseGenericXML(xml) {
  // Strip all tags, decode entities, collapse whitespace
  const text = xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
  return text.length > 100 ? text : null;
}

function parseVTT(vtt) {
  const parts = []; let prev = "";
  for (const line of vtt.split("\n")) {
    const l = line.trim().replace(/<[^>]+>/g, "");
    if (!l || l.startsWith("WEBVTT") || l.includes("-->") || /^\d+$/.test(l)) continue;
    if (l !== prev) { parts.push(l); prev = l; }
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 50 ? joined : null;
}

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
