/**
 * TripExtract — Extract API
 * Vercel serverless function
 *
 * POST /api/extract
 * Body: { transcript: string, videoTitle: string }
 * Returns: { places: [...] }
 *
 * Calls Anthropic Claude on the server — API key stays private.
 */

const SYSTEM_PROMPT = `You are a travel assistant that extracts every named location from YouTube travel video transcripts.

Extract ALL types of places mentioned — not just restaurants. This includes:
- Landmarks, monuments, historic sites, ruins, castles, temples, churches, cathedrals
- Museums, galleries, cultural centers, theaters
- Parks, gardens, nature reserves, viewpoints, beaches, waterfalls, hiking trails
- Neighborhoods, districts, plazas, squares, markets, bazaars
- Hotels, hostels, guesthouses
- Restaurants, cafes, bars, street food stalls
- Shops, malls, boutiques worth visiting
- Any other specific named place a traveler would want to visit

Do NOT bias toward food. A historic site, viewpoint, or museum is just as important to extract as a restaurant.

CRITICAL OUTPUT RULE: Your ENTIRE response must be a single raw JSON array starting with [ and ending with ].
Do NOT use markdown. Do NOT use code fences (\`\`\`). Do NOT add any text before or after the array.
The very first character of your response must be [ and the very last must be ].

Each object in the array must have exactly these fields:
{
  "name": "Full official name of the place",
  "type": "restaurant|cafe|bar|hotel|landmark|neighborhood|park|market|museum|attraction|other",
  "city": "City and/or neighborhood (e.g. 'Rome, Italy' or 'Trastevere, Rome')",
  "knownFor": "1-2 sentence description of what this place is known for, based on the transcript",
  "since": "Year established if mentioned, otherwise empty string"
}

Rules:
- Only include real, named places (not generic descriptions like "a small church" or "a local market")
- If a place is mentioned multiple times, include it only once
- Do not include the city or country itself as an entry unless a specific site within it is meant
- Keep knownFor concise and specific to what the transcript says
- When in doubt, include the place — it is better to over-extract than to miss something`;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { transcript, videoTitle } = req.body || {};
  if (!transcript || typeof transcript !== "string") {
    return res.status(400).json({ error: "Missing or invalid transcript" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server not configured (missing ANTHROPIC_API_KEY)" });

  const maxChars = 40000;
  const truncated = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + "\n[transcript truncated]"
    : transcript;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `Video title: "${videoTitle || "Unknown"}"\n\nTranscript:\n${truncated}\n\nExtract all places mentioned in this video.`,
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(502).json({ error: err.error?.message || `Anthropic error ${response.status}` });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || "";

    const arrayStr = extractJsonArray(raw);
    if (!arrayStr) {
      console.error("[TripExtract] Claude response could not be parsed:", raw.slice(0, 200));
      return res.status(502).json({ error: "AI response could not be parsed" });
    }

    const places = JSON.parse(arrayStr);
    if (!Array.isArray(places)) return res.status(502).json({ error: "AI returned non-array" });

    return res.status(200).json({ places });
  } catch (e) {
    console.error("[TripExtract] extract error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ─── Bracket-counting JSON array extractor ────────────────────────────────────

function extractJsonArray(text) {
  const start = text.indexOf("[");
  if (start === -1) return null;

  // Pass 1: find complete array
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc)                 { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true;  continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      if (--depth === 0 && c === "]") return text.slice(start, i + 1);
      if (depth < 0) break;
    }
  }

  // Pass 2: salvage complete objects from truncated response
  const objects = [];
  depth = 0; inStr = false; esc = false;
  let objStart = -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (esc)                 { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true;  continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === "{") { if (depth === 0) objStart = i; depth++; }
    else if (c === "}") {
      if (--depth === 0 && objStart !== -1) {
        objects.push(text.slice(objStart, i + 1));
        objStart = -1;
      }
    }
  }
  if (objects.length > 0) {
    try {
      const salvaged = "[" + objects.join(",") + "]";
      JSON.parse(salvaged);
      return salvaged;
    } catch { /* fall through */ }
  }
  return null;
}
