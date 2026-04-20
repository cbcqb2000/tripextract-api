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

const SYSTEM_PROMPT = `You are a travel location extractor. Your job is to find every specific place mentioned in a travel video transcript.

EXTRACT EVERYTHING — museums, sculptures, buildings, parks, historic sites, neighborhoods, viewpoints, monuments, halls of fame, stadiums, bridges, markets, restaurants, bars, hotels, and any other place a visitor would go. If the video title says "27 stops", find all 27.

Use the video title as a strong hint. If the title mentions a number of stops or places, you should find approximately that many. Use your knowledge of the city to fill in official place names when the transcript uses a short or informal reference (e.g. "the rock hall" → "Rock and Roll Hall of Fame").

CRITICAL OUTPUT RULE: Your ENTIRE response must be a single raw JSON array starting with [ and ending with ].
Do NOT use markdown. Do NOT use code fences (\`\`\`). Do NOT add any text before or after the array.
The very first character of your response must be [ and the very last must be ].

Each object in the array must have exactly these fields:
{
  "name": "Full official name of the place",
  "type": "restaurant|cafe|bar|hotel|landmark|neighborhood|park|market|museum|attraction|other",
  "city": "City and state/country (e.g. 'Cleveland, OH' or 'Trastevere, Rome')",
  "knownFor": "1-2 sentence description of what this place is known for",
  "since": "Year established if mentioned, otherwise empty string"
}

Rules:
- NEVER return just the city name as a place — always return the specific sites within it
- Include a place even if only briefly mentioned or shown
- If a place is mentioned multiple times, include it only once
- Use your world knowledge to infer the full official name from nicknames or short references
- Keep knownFor concise and informative
- It is always better to include too many places than to miss one`;

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
          content: `Video title: "${videoTitle || "Unknown"}"\n\nIMPORTANT: The title above tells you what city and approximately how many places to find. Extract every single one.\n\nTranscript:\n${truncated}\n\nExtract every place mentioned or implied in this video. Do not return the city itself — return the specific sites, attractions, and locations within it.`,
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
