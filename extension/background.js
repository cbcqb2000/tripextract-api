/**
 * TripExtract — Background Service Worker
 */

// ─── Your Vercel API URL ──────────────────────────────────────────────────────
// After you deploy TripExtract-API to Vercel, paste your URL here.
// Example: "https://tripextract-api.vercel.app"
// Leave empty ("") to skip this strategy and fall back to the others.
const TRANSCRIPT_API_BASE = "https://tripextract-api.vercel.app";

// ─── Network rules ────────────────────────────────────────────────────────────
// Strip browser-fingerprint headers from timedtext requests.
// Chrome adds Sec-Fetch-* and X-Client-Data to all extension fetches.
// YouTube detects these and returns 200 with an empty body (anti-scraping).
// Node.js / server-side requests don't carry these headers — that's why
// tools like youtubetotranscript.com work. declarativeNetRequest removes them
// at the network layer before the request leaves Chrome.

async function setupNetRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [201],
      addRules: [{
        id: 201,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Sec-Fetch-Site",  operation: "remove" },
            { header: "Sec-Fetch-Mode",  operation: "remove" },
            { header: "Sec-Fetch-Dest",  operation: "remove" },
            { header: "Sec-Fetch-User",  operation: "remove" },
            { header: "X-Client-Data",   operation: "remove" },
            { header: "Origin",          operation: "remove" },
          ],
        },
        condition: {
          urlFilter: "||youtube.com/api/timedtext*",
          resourceTypes: ["xmlhttprequest", "other"],
        },
      }],
    });
    console.log("[TripExtract] Net rules registered.");
  } catch (e) {
    console.warn("[TripExtract] Net rules setup failed:", e.message);
  }
}

chrome.runtime.onInstalled.addListener(setupNetRules);
chrome.runtime.onStartup.addListener(setupNetRules);

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_TRANSCRIPT") {
    getTranscript(message.tabId)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === "EXTRACT_PLACES") {
    runFullPipeline(message)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ─── Coordinator ──────────────────────────────────────────────────────────────

async function getTranscript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const videoId = new URLSearchParams(new URL(tab.url).search).get("v");
  if (!videoId) throw new Error("Could not read video ID from tab URL.");

  const errors = [];

  // Strategy 0a — URL-proxy: extension extracts signed caption URL from the page
  // (user cookies mean YouTube gives us the URL), then our Vercel server fetches
  // it cleanly with no browser fingerprint. Best of both worlds.
  if (TRANSCRIPT_API_BASE) {
    try {
      const r = await strategyProxyUrl(tabId, videoId);
      if (r?.transcript) return r;
    } catch (e) { errors.push("S0a: " + e.message); }
  }

  // Strategy 0b — Direct Vercel API call by video ID (Innertube / scraping)
  if (TRANSCRIPT_API_BASE) {
    try {
      const r = await strategyOurApi(videoId);
      if (r?.transcript) return r;
    } catch (e) { errors.push("S0b: " + e.message); }
  }

  // Strategy 1 — In-page extractor (MAIN world, credentials: omit for caption URLs)
  //   A) ytInitialPlayerResponse in memory → fetch track URL
  //   B) Fresh page fetch → extract tracks → fetch track URL
  //   C) Direct timedtext API (various lang/kind combos)
  try {
    const r = await strategyComprehensive(tabId, videoId);
    if (r?.transcript) return r;
  } catch (e) { errors.push("S1: " + e.message); }

  // Strategy 2 — Background SW fetch (no YouTube cookies — mirrors server-side tools)
  try {
    const r = await strategyBackgroundFetch(videoId);
    if (r?.transcript) return r;
  } catch (e) { errors.push("S2: " + e.message); }

  // Strategy 3 — YouTube's innertube get_transcript API (MAIN world fetch)
  console.log("[TripExtract] Trying S3 (innertube)...");
  try {
    const r = await strategyInnertube(tabId, videoId);
    if (r?.transcript) { console.log("[TripExtract] S3 succeeded, len:", r.transcript.length); return r; }
    console.warn("[TripExtract] S3 returned no transcript");
  } catch (e) { console.warn("[TripExtract] S3 failed:", e.message); errors.push("S3: " + e.message); }

  // Strategy 4 — Open YouTube's transcript panel, scrape DOM text
  console.log("[TripExtract] Trying S4 (transcript panel)...");
  try {
    const r = await strategyPanel(tabId);
    if (r?.transcript) { console.log("[TripExtract] S4 succeeded, len:", r.transcript.length); return r; }
    console.warn("[TripExtract] S4 returned no transcript");
  } catch (e) { console.warn("[TripExtract] S4 failed:", e.message); errors.push("S4: " + e.message); }

  const detail = errors.join(" || ");
  console.warn("[TripExtract] All strategies failed:", detail);
  throw new Error("DIAG:" + detail);
}

// ─── Strategy 0a: URL-proxy ───────────────────────────────────────────────────
// The extension runs inside the YouTube tab (with the user's cookies), so
// YouTube gives it the signed timedtext URL inside ytInitialPlayerResponse.
// We pass that URL to our Vercel server, which fetches it with no browser
// headers — the exact thing YouTube uses to detect and block extension requests.

async function strategyProxyUrl(tabId, videoId) {
  if (!TRANSCRIPT_API_BASE) throw new Error("TRANSCRIPT_API_BASE not set");

  // Always fetch the page fresh to get the newest signed caption URLs.
  // (In-memory ytInitialPlayerResponse URLs can be stale and return 404.)
  // Runs in MAIN world so the user's YouTube cookies are automatically sent.
  const scriptResults = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (vid) => {
      try {
        const r = await fetch(`https://www.youtube.com/watch?v=${vid}`,
          { headers: { "Accept-Language": "en-US,en;q=0.9" } });
        if (!r.ok) return { error: "page fetch " + r.status };
        const html = await r.text();

        // Inline bracket-counting JSON extractor
        const key = "ytInitialPlayerResponse";
        let idx = html.indexOf(key);
        if (idx === -1) return { error: "ytInitialPlayerResponse not in page" };
        let i = idx + key.length;
        while (i < html.length && " \t\r\n".includes(html[i])) i++;
        if (html[i] !== "=") return { error: "no = after ytInitialPlayerResponse" };
        i++;
        while (i < html.length && " \t\r\n".includes(html[i])) i++;
        if (html[i] !== "{") return { error: "no { after =" };

        let start = i, depth = 0, inStr = false, esc = false, pr = null;
        for (let j = start; j < html.length; j++) {
          const c = html[j];
          if (esc) { esc = false; continue; }
          if (c === "\\" && inStr) { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === "{") depth++;
          else if (c === "}" && --depth === 0) {
            try { pr = JSON.parse(html.slice(start, j + 1)); } catch {}
            break;
          }
        }

        if (!pr) return { error: "could not parse ytInitialPlayerResponse JSON" };
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!tracks?.length) {
          return { error: "no caption tracks (keys: " + Object.keys(pr).slice(0, 6).join(",") + ")" };
        }

        // Collect up to 3 candidate URLs (en manual, en ASR, any en, first)
        const ordered = [
          tracks.find((t) => t.languageCode === "en" && !t.kind),
          tracks.find((t) => t.languageCode === "en"),
          tracks.find((t) => t.languageCode?.startsWith("en")),
          tracks[0],
        ].filter(Boolean).filter((t, i, arr) => arr.indexOf(t) === i);

        const urls = ordered.map((t) =>
          t.baseUrl?.startsWith("http") ? t.baseUrl : "https://www.youtube.com" + t.baseUrl
        ).filter(Boolean);

        if (!urls.length) return { error: "tracks found but no baseUrls" };
        return { captionUrls: urls, trackCount: tracks.length };
      } catch (e) {
        return { error: "threw: " + e.message };
      }
    },
    args: [videoId],
  });

  const inner = scriptResults?.[0]?.result;
  if (!inner?.captionUrls?.length) {
    throw new Error("extract: " + (inner?.error || "no captionUrls from page"));
  }

  // Try each candidate URL via Vercel until one succeeds
  const proxyErrors = [];
  for (const captionUrl of inner.captionUrls) {
    try {
      const apiUrl = `${TRANSCRIPT_API_BASE}/api/transcript?v=${videoId}&url=${encodeURIComponent(captionUrl)}`;
      const resp = await fetch(apiUrl);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        proxyErrors.push(body.error || "proxy " + resp.status);
        continue;
      }
      const data = await resp.json();
      if (data.transcript) return { transcript: data.transcript, videoId };
      proxyErrors.push("no transcript in response");
    } catch (e) {
      proxyErrors.push(e.message);
    }
  }
  throw new Error(`(${inner.trackCount} tracks): ${proxyErrors.join(" | ")}`);
}

// ─── Strategy 0b: Our own Vercel API (direct by video ID) ────────────────────

async function strategyOurApi(videoId) {
  const url = `${TRANSCRIPT_API_BASE}/api/transcript?v=${videoId}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `API returned ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.transcript) throw new Error("API response had no transcript field");
  return { transcript: data.transcript, videoId };
}

// ─── Strategy 1: Comprehensive in-page extractor ─────────────────────────────

async function strategyComprehensive(tabId, videoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (vid) => {

      // helpers ─────────────────────────────────────────────────────────────

      function pickTrack(tracks) {
        return (
          tracks.find((t) => t.languageCode === "en" && !t.kind) ||
          tracks.find((t) => t.languageCode === "en") ||
          tracks.find((t) => t.languageCode?.startsWith("en")) ||
          tracks[0]
        );
      }

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

      // Parse XML/TTML caption format (YouTube's default)
      function parseXMLCaptions(xml) {
        const parts = [];
        const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
          const t = m[1]
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, " ")
            .trim();
          if (t) parts.push(t);
        }
        const joined = parts.join(" ").replace(/\s+/g, " ").trim();
        return joined.length > 50 ? joined : null;
      }

      // Parse WebVTT format
      function parseVTT(vtt) {
        const parts = [];
        const lines = vtt.split("\n");
        let prevLine = "";
        for (const line of lines) {
          const l = line.trim();
          if (!l || l.startsWith("WEBVTT") || l.includes("-->") || /^\d+$/.test(l)) continue;
          const clean = l.replace(/<[^>]+>/g, "").trim();
          if (clean && clean !== prevLine) { parts.push(clean); prevLine = clean; }
        }
        const joined = parts.join(" ").replace(/\s+/g, " ").trim();
        return joined.length > 50 ? joined : null;
      }

      async function tracksToTranscript(tracks, logArr) {
        const track = pickTrack(tracks);
        if (!track?.baseUrl) { logArr?.push("ttt: no baseUrl"); return null; }

        const base = track.baseUrl.startsWith("http")
          ? track.baseUrl
          : "https://www.youtube.com" + track.baseUrl;

        // YouTube's baseUrl is signed for XML/TTML (their default format).
        // Try JSON3 first (set via URL param), then fall back to the default format.
        const urls = (() => {
          try {
            const u = new URL(base);
            u.searchParams.set("fmt", "json3");
            return [u.toString(), base];
          } catch { return [base + "&fmt=json3", base]; }
        })();

        // The signed caption URLs are generated for anonymous (no-cookie) access.
        // Sending YouTube session cookies causes a silent empty 200 response.
        // credentials: "omit" strips cookies even for same-origin fetches.
        for (const url of urls) {
          try {
            const r = await fetch(url, { credentials: "omit" });
            const text = await r.text();
            logArr?.push("ttt(" + (url.includes("fmt=json3") ? "json3" : "xml") + "): " +
              r.status + " len=" + text.length +
              " starts=" + JSON.stringify(text.slice(0, 30)));
            if (!r.ok || !text.trim()) continue;

            if (text.trim().startsWith("{")) {
              const d = JSON.parse(text);
              logArr?.push("ttt: events=" + (d?.events?.length || 0));
              const t = parseEvents(d?.events);
              if (t) return t;
            } else if (text.includes("<text")) {
              const t = parseXMLCaptions(text);
              logArr?.push("ttt: xml→" + (t ? t.length + "chars" : "null"));
              if (t) return t;
            } else if (text.startsWith("WEBVTT")) {
              const t = parseVTT(text);
              logArr?.push("ttt: vtt→" + (t ? t.length + "chars" : "null"));
              if (t) return t;
            } else {
              logArr?.push("ttt: unknown fmt prefix=" + JSON.stringify(text.slice(0, 50)));
            }
          } catch (e) { logArr?.push("ttt: threw " + e.message); }
        }
        return null;
      }

      // Bracket-counting JSON extractor — regex can't handle 500kb+ nested JSON
      // Handles: "varName = {", "varName={", "varName =\n{", etc.
      function extractJson(html, varName) {
        const idx = html.indexOf(varName);
        if (idx === -1) return null;
        let i = idx + varName.length;
        // skip optional whitespace before "="
        while (i < html.length && " \t\r\n".includes(html[i])) i++;
        if (html[i] !== "=") return null;
        i++; // consume "="
        // skip optional whitespace after "="
        while (i < html.length && " \t\r\n".includes(html[i])) i++;
        if (html[i] !== "{") return null;
        const start = i;
        let depth = 0, inStr = false, esc = false;
        for (let j = start; j < html.length; j++) {
          const c = html[j];
          if (esc)              { esc = false; continue; }
          if (c === "\\" && inStr) { esc = true; continue; }
          if (c === '"')        { inStr = !inStr; continue; }
          if (inStr)            continue;
          if (c === "{")        depth++;
          else if (c === "}") {
            if (--depth === 0) {
              try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; }
            }
          }
        }
        return null;
      }

      const meta = {
        videoId: vid,
        title: document.title.replace(" - YouTube", "").trim(),
      };
      const log = []; // collects diagnostic info from each sub-approach

      // Sub-approach A: ytInitialPlayerResponse already in memory ─────────────
      try {
        const pr = window.ytInitialPlayerResponse;
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks?.length) {
          const transcript = await tracksToTranscript(tracks, log);
          if (transcript) return { ...meta, transcript };
          log.push("A: tracks found(" + tracks.length + ") but fetch/parse failed");
        } else {
          log.push("A: no caption tracks in ytInitialPlayerResponse (keys: " +
            Object.keys(pr || {}).slice(0, 5).join(",") + ")");
        }
      } catch (e) { log.push("A: threw " + e.message); }

      // Sub-approach B: fetch the YouTube page from inside the tab ────────────
      // Runs in page context so YouTube cookies are automatically included.
      try {
        const r = await fetch(`https://www.youtube.com/watch?v=${vid}`, {
          headers: { "Accept-Language": "en-US,en;q=0.9" },
        });
        log.push("B: page fetch " + r.status + " len=" + r.headers.get("content-length"));
        if (r.ok) {
          const html = await r.text();
          const hasVar = html.includes("ytInitialPlayerResponse");
          log.push("B: html len=" + html.length + " hasVar=" + hasVar);
          if (hasVar) {
            const pr = extractJson(html, "ytInitialPlayerResponse");
            log.push("B: extractJson=" + (pr ? "ok" : "null"));
            if (pr) {
              const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
              log.push("B: tracks=" + (tracks?.length || 0));
              if (tracks?.length) {
                const transcript = await tracksToTranscript(tracks, log);
                if (transcript) return { ...meta, transcript };
                log.push("B: tracksToTranscript failed");
              }
            }
          }
        }
      } catch (e) { log.push("B: threw " + e.message); }

      // Sub-approach C: timedtext API with multiple language/kind variants ────
      // Also try XML format (no fmt param) in case json3 returns empty.
      const candidates = [
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=en&fmt=json3`,
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=en&kind=asr&fmt=json3`,
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=en`,
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=en&kind=asr`,
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=en-US&fmt=json3`,
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=en-US`,
      ];
      for (const url of candidates) {
        try {
          const r = await fetch(url, { credentials: "omit" });
          const text = await r.text();
          log.push("C: " + url.split("?")[1] + " → " + r.status + " len=" + text.length);
          if (!r.ok || !text.trim()) continue;
          let transcript = null;
          if (text.trim().startsWith("{")) {
            try { transcript = parseEvents(JSON.parse(text)?.events); } catch {}
          } else if (text.includes("<text")) {
            transcript = parseXMLCaptions(text);
          } else if (text.startsWith("WEBVTT")) {
            transcript = parseVTT(text);
          }
          log.push("C: parsed→" + (transcript ? transcript.length + "chars" : "null"));
          if (transcript) return { ...meta, transcript };
        } catch (e) { log.push("C: threw " + e.message); }
      }

      return { error: log.join(" | ") };
    },
    args: [videoId],
  });

  const result = results?.[0]?.result;
  if (!result || result.error) throw new Error(result?.error || "No result from S1");
  return result;
}

// ─── Strategy 2: Background service worker fetch (no YouTube cookies) ────────
// The background SW runs from chrome-extension:// origin, so YouTube domain
// cookies are never attached — exactly like a server-side / curl request.
// This mirrors what youtubetotranscript.com does.

function bgExtractJson(html, varName) {
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

function bgParseEvents(events) {
  if (!events) return null;
  const text = events
    .filter((e) => e.segs)
    .map((e) => e.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim())
    .filter((l) => l.length > 0 && l !== "\u200b")
    .join(" ").replace(/\s+/g, " ").trim();
  return text.length > 50 ? text : null;
}

function bgParseXML(xml) {
  const parts = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, " ")
      .trim();
    if (t) parts.push(t);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 50 ? joined : null;
}

async function strategyBackgroundFetch(videoId) {
  // Fetch without YouTube cookies (BG SW never has them for youtube.com)
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!pageResp.ok) throw new Error("BG page status " + pageResp.status);
  const html = await pageResp.text();

  const pr = bgExtractJson(html, "ytInitialPlayerResponse");
  if (!pr) throw new Error("BG: ytInitialPlayerResponse not found");

  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) throw new Error("BG: no caption tracks");

  const track =
    tracks.find((t) => t.languageCode === "en" && !t.kind) ||
    tracks.find((t) => t.languageCode === "en") ||
    tracks.find((t) => t.languageCode?.startsWith("en")) ||
    tracks[0];

  if (!track?.baseUrl) throw new Error("BG: no baseUrl on track");

  const base = track.baseUrl.startsWith("http")
    ? track.baseUrl
    : "https://www.youtube.com" + track.baseUrl;

  // Try JSON3 then the original signed URL (XML/TTML)
  const capUrls = (() => {
    try { const u = new URL(base); u.searchParams.set("fmt", "json3"); return [u.toString(), base]; }
    catch { return [base + "&fmt=json3", base]; }
  })();

  for (const url of capUrls) {
    const r = await fetch(url, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
    const text = await r.text();
    console.log("[TripExtract] BG caption:", r.status, "len:", text.length,
      "fmt:", url.includes("fmt=json3") ? "json3" : "xml");
    if (!r.ok || !text.trim()) continue;

    if (text.trim().startsWith("{")) {
      try { const t = bgParseEvents(JSON.parse(text)?.events); if (t) return { transcript: t, videoId }; }
      catch {}
    }
    if (text.includes("<text")) {
      const t = bgParseXML(text);
      if (t) return { transcript: t, videoId };
    }
    if (text.startsWith("WEBVTT")) {
      const lines = text.split("\n");
      const parts = []; let prev = "";
      for (const l of lines) {
        const c = l.trim().replace(/<[^>]+>/g, "");
        if (!c || c.startsWith("WEBVTT") || c.includes("-->") || /^\d+$/.test(c)) continue;
        if (c !== prev) { parts.push(c); prev = c; }
      }
      const t = parts.join(" ").replace(/\s+/g, " ").trim();
      if (t.length > 50) return { transcript: t, videoId };
    }
  }
  throw new Error("BG: caption URLs returned no usable content");
}

// ─── Strategy 3: YouTube innertube get_transcript API ────────────────────────
// Runs inside executeScript (MAIN world) so fetch carries YouTube session cookies
// and browser context. X-Goog-Visitor-Id is the critical missing header that
// caused the 400 errors.

async function strategyInnertube(tabId, videoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (vid) => {
      try {
        // Read all config values YouTube's own JS uses for API calls
        const get = (k) =>
          window.ytcfg?.get?.(k) ||
          window.ytcfg?.data_?.[k] ||
          window.yt?.config_?.[k];

        const clientVersion = get("INNERTUBE_CLIENT_VERSION") || "2.20240101";
        const visitorData   = get("VISITOR_DATA") || get("INNERTUBE_CONTEXT_CLIENT_NAME") || "";
        const hl = get("HL") || "en";
        const gl = get("GL") || "US";

        // protobuf field 1 (wire type 2 = length-delimited) = video ID string
        const params = btoa(
          String.fromCharCode(0x0a, vid.length) + vid
        ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

        const resp = await fetch(
          "https://www.youtube.com/youtubei/v1/get_transcript",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-YouTube-Client-Name": "1",
              "X-YouTube-Client-Version": clientVersion,
              // X-Goog-Visitor-Id is required since mid-2024; omitting it causes 400
              ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
            },
            body: JSON.stringify({
              context: {
                client: {
                  clientName: "WEB",
                  clientVersion,
                  hl,
                  gl,
                  visitorData,
                  originalUrl: window.location.href,
                  userAgent: navigator.userAgent,
                },
              },
              params,
            }),
          }
        );

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { error: `innertube ${resp.status} body=${body.slice(0, 80)}` };
        }

        const data = await resp.json();
        const segments =
          data?.actions?.[0]?.updateEngagementPanelAction?.content
            ?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer
            ?.initialSegments || [];

        if (!segments.length) {
          const keys = Object.keys(data || {}).slice(0, 5).join(",");
          return { error: `innertube: no segments (keys: ${keys})` };
        }

        const transcript = segments
          .map((s) =>
            s?.transcriptSegmentRenderer?.snippet?.runs?.map((r) => r.text).join("") || ""
          )
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        if (transcript.length < 50) return { error: "innertube: transcript too short" };

        return {
          transcript,
          videoId: vid,
          title: document.title.replace(" - YouTube", "").trim(),
        };
      } catch (e) {
        return { error: "innertube threw: " + e.message };
      }
    },
    args: [videoId],
  });

  const result = results?.[0]?.result;
  if (!result || result.error) throw new Error(result?.error || "S3 no result");
  return result;
}

// ─── Strategy 4: Open transcript panel, scrape DOM ───────────────────────────
// Uses YouTube's own UI — bypasses all po_token and API issues because YouTube's
// player handles authentication internally when rendering the transcript panel.

async function strategyPanel(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function qsa(sel)  { return Array.from(document.querySelectorAll(sel)); }

      const vid   = new URLSearchParams(window.location.search).get("v");
      const title = document.title.replace(" - YouTube", "").trim();

      // ── readPanel: tries multiple selector patterns + raw container fallback ──
      function readPanel() {
        // Pattern 1: classic ytd-transcript-segment-renderer with .segment-text
        let segs = qsa("ytd-transcript-segment-renderer .segment-text");
        if (segs.length >= 3) {
          const t = segs.map(el => el.textContent.trim()).filter(Boolean)
            .join(" ").replace(/\s+/g, " ").trim();
          if (t.length > 100) return t;
        }

        // Pattern 2: yt-formatted-string inside each segment renderer
        segs = qsa("ytd-transcript-segment-renderer yt-formatted-string");
        if (segs.length >= 3) {
          const t = segs.map(el => el.textContent.trim()).filter(Boolean)
            .join(" ").replace(/\s+/g, " ").trim();
          if (t.length > 100) return t;
        }

        // Pattern 3: any direct children of transcript segment renderer
        segs = qsa("ytd-transcript-segment-renderer");
        if (segs.length >= 3) {
          const t = segs.map(el => {
            // Strip out timestamp spans, keep text
            const clone = el.cloneNode(true);
            clone.querySelectorAll("[class*=\"timestamp\"], [class*=\"time\"]").forEach(n => n.remove());
            return clone.textContent.replace(/\d+:\d+/g, "").trim();
          }).filter(Boolean)
            .join(" ").replace(/\s+/g, " ").trim();
          if (t.length > 100) return t;
        }

        // Pattern 4: engagement panel or "In this video" transcript container
        const containers = qsa(
          "ytd-engagement-panel-section-list-renderer, ytd-transcript-renderer, #transcript-scrollbox"
        );
        for (const c of containers) {
          const raw = (c.innerText || c.textContent || "");
          if (raw.length < 200) continue;
          // Strip timestamps (e.g. "1:23", "12:34") and UI chrome
          const lines = raw.split("\n")
            .map(l => l.trim())
            .filter(l =>
              l &&
              !/^\d+:\d+(:\d+)?$/.test(l) &&
              !["Search transcript", "Chapters", "Transcript", "In this video"].includes(l)
            );
          const t = lines.join(" ").replace(/\s+/g, " ").trim();
          if (t.length > 200) return t;
        }

        return null;
      }

      // Already open?
      let t = readPanel();
      if (t) return { transcript: t, videoId: vid, title };

      // ── Approach A: "Open/Show transcript" button directly on page ────────────
      // YouTube's newer "In this video" panel or description area exposes this
      // as a direct button — no "..." menu needed.
      // IMPORTANT: Only match buttons INSIDE the video page area, never navigation.
      const directBtn = qsa(
        "#above-the-fold button, ytd-watch-metadata button, " +
        "ytd-video-secondary-info-renderer button, #primary button"
      ).find((el) => {
        const txt   = (el.textContent || "").trim().toLowerCase();
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        return (
          txt === "show transcript" || txt === "open transcript" ||
          label === "show transcript" || label === "open transcript"
        );
      });

      if (directBtn) {
        directBtn.click();
        // Wait up to 8s — transcript panel can be slow to render
        for (let i = 0; i < 40; i++) {
          await sleep(200);
          t = readPanel();
          if (t) return { transcript: t, videoId: vid, title };
        }
        // Panel was opened but readPanel still null — return diagnostic
        const panelEl = document.querySelector(
          "ytd-engagement-panel-section-list-renderer, ytd-transcript-renderer"
        );
        if (panelEl) {
          const raw = (panelEl.innerText || "").slice(0, 300);
          return { error: "panel open but readPanel failed. container preview: " + JSON.stringify(raw) };
        }
      }

      // ── Approach B: Click "⋮ More actions" → "Show transcript" ───────────────
      const inVideoArea = (el) =>
        !el.closest("ytd-comments") &&
        !el.closest("ytd-compact-video-renderer") &&
        !el.closest("ytd-grid-video-renderer") &&
        !el.closest("ytd-rich-item-renderer") &&
        !el.closest("ytd-playlist-panel-renderer") &&
        // Exclude top-level navigation (guide/sidebar)
        !el.closest("ytd-guide-renderer") &&
        !el.closest("tp-yt-app-drawer");

      const moreBtn =
        qsa("#above-the-fold button[aria-label], ytd-watch-metadata button[aria-label]")
          .find((b) => b.getAttribute("aria-label").toLowerCase().includes("more") && inVideoArea(b)) ||
        qsa("button[aria-label]")
          .find((b) => b.getAttribute("aria-label").toLowerCase() === "more actions" && inVideoArea(b)) ||
        document.querySelector("#above-the-fold ytd-menu-renderer yt-icon-button button") ||
        document.querySelector("ytd-watch-metadata #button-shape button") ||
        qsa("ytd-menu-renderer button").find(inVideoArea);

      if (!moreBtn) return { error: "More actions button not found" };

      moreBtn.click();
      await sleep(900);

      const menuItems = qsa(
        "ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model, " +
        "ytd-popup-container yt-formatted-string, ytd-menu-popup-renderer yt-formatted-string"
      );
      const menuTexts = menuItems.map(el => el.textContent?.trim()).filter(Boolean);
      const transcriptBtn = menuItems.find(el => el.textContent?.toLowerCase().includes("transcript"));

      if (!transcriptBtn) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return { error: `transcript not in menu. Items: [${menuTexts.slice(0, 12).join(" | ")}]` };
      }

      transcriptBtn.click();
      await sleep(800);

      for (let i = 0; i < 40; i++) {
        t = readPanel();
        if (t) return { transcript: t, videoId: vid, title };
        await sleep(200);
      }

      // Diagnostic: what did the container actually contain?
      const panelEl = document.querySelector(
        "ytd-engagement-panel-section-list-renderer, ytd-transcript-renderer"
      );
      const raw = panelEl ? (panelEl.innerText || "").slice(0, 300) : "no panel element found";
      return { error: "panel opened but readPanel failed. container: " + JSON.stringify(raw) };
    },
  });

  const result = results?.[0]?.result;
  if (!result || result.error) throw new Error(result?.error || "Panel scrape failed");
  return result;
}

// ─── Full AI + Places pipeline ────────────────────────────────────────────────

async function runFullPipeline({ transcript, videoTitle }) {
  // All API calls go through the Vercel backend — no keys in the extension.
  const places = await extractPlaces(transcript, videoTitle);
  if (!places.length) throw new Error("No places found in this video.");

  const verified = await verifyAllPlaces(places);
  return { places: verified, verifiedCount: verified.filter((p) => p.verified).length };
}

// ─── Extract via Vercel /api/extract ─────────────────────────────────────────

async function extractPlaces(transcript, videoTitle) {
  if (!TRANSCRIPT_API_BASE) throw new Error("TRANSCRIPT_API_BASE not set");

  const response = await fetch(`${TRANSCRIPT_API_BASE}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, videoTitle }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Extract API error ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data.places)) throw new Error("Extract API returned no places array");
  return data.places;
}

// ─── Google Places via Vercel /api/places ─────────────────────────────────────

async function verifyAllPlaces(places) {
  const results = [];
  for (let i = 0; i < places.length; i++) {
    try {
      const v = await lookupPlace(places[i]);
      results.push({ ...places[i], ...v, verified: true });
    } catch (err) {
      console.warn(`[TripExtract] Could not verify "${places[i].name}":`, err.message);
      results.push({ ...places[i], verified: false });
    }
    if (i < places.length - 1) await sleep(80);
  }
  return results;
}

async function lookupPlace(place) {
  if (!TRANSCRIPT_API_BASE) throw new Error("TRANSCRIPT_API_BASE not set");

  const response = await fetch(`${TRANSCRIPT_API_BASE}/api/places`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: place.name, city: place.city }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Places API error ${response.status}`);
  }

  return response.json();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
