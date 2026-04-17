/**
 * TripExtract — Transcript API
 * Vercel serverless function: GET /api/transcript?v=VIDEO_ID
 *
 * Fetches YouTube captions server-side (no browser fingerprint headers),
 * which is why this works when the Chrome extension itself cannot.
 */

export default async function handler(req, res) {
  // Allow requests from the Chrome extension and any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const videoId = req.query.v || req.query.videoId;

  // Validate YouTube video ID format (always 11 chars)
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Missing or invalid video ID. Use ?v=VIDEO_ID" });
  }

  try {
    const transcript = await fetchTranscript(videoId);
    return res.status(200).json({ transcript, videoId });
  } catch (e) {
    console.error(`[TripExtract] transcript error for ${videoId}:`, e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─── Core fetcher ─────────────────────────────────────────────────────────────

async function fetchTranscript(videoId) {
  // Step 1: Fetch the YouTube watch page.
  // Running server-side means no Sec-Fetch-*, X-Client-Data, or Origin headers —
  // the exact headers that cause YouTube to return empty responses to extensions.
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!pageResp.ok) {
    throw new Error(`YouTube page returned ${pageResp.status}`);
  }

  const html = await pageResp.text();

  // Step 2: Extract ytInitialPlayerResponse (contains the caption track URLs)
  const playerResponse = extractJson(html, "ytInitialPlayerResponse");
  if (!playerResponse) {
    throw new Error("Could not find player data in YouTube page");
  }

  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!tracks?.length) {
    throw new Error("No caption tracks found for this video");
  }

  // Step 3: Pick the best English caption track
  const track =
    tracks.find((t) => t.languageCode === "en" && !t.kind) || // manual English
    tracks.find((t) => t.languageCode === "en") ||             // any English (incl. ASR)
    tracks.find((t) => t.languageCode?.startsWith("en")) ||    // en-US, en-GB, etc.
    tracks[0];                                                  // whatever exists

  if (!track?.baseUrl) {
    throw new Error("Caption track has no download URL");
  }

  const base = track.baseUrl.startsWith("http")
    ? track.baseUrl
    : "https://www.youtube.com" + track.baseUrl;

  // Step 4: Fetch the caption content.
  // Try JSON3 format first (easier to parse), then fall back to XML/TTML.
  const urls = buildCaptionUrls(base);

  for (const url of urls) {
    const r = await fetch(url, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });

    const text = await r.text();
    if (!r.ok || !text.trim()) continue;

    // JSON3 format
    if (text.trim().startsWith("{")) {
      try {
        const data = JSON.parse(text);
        const transcript = parseEvents(data?.events);
        if (transcript) return transcript;
      } catch {}
    }

    // XML/TTML format (YouTube's default)
    if (text.includes("<text")) {
      const transcript = parseXML(text);
      if (transcript) return transcript;
    }

    // WebVTT format
    if (text.startsWith("WEBVTT")) {
      const transcript = parseVTT(text);
      if (transcript) return transcript;
    }
  }

  throw new Error("Caption URLs returned no usable content");
}

// ─── URL builder ──────────────────────────────────────────────────────────────

function buildCaptionUrls(base) {
  try {
    const json3 = new URL(base);
    json3.searchParams.set("fmt", "json3");
    return [json3.toString(), base];
  } catch {
    return [base + "&fmt=json3", base];
  }
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseEvents(events) {
  if (!events) return null;
  const text = events
    .filter((e) => e.segs)
    .map((e) =>
      e.segs
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\n/g, " ")
        .trim()
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
