
/**
 * TripExtract — Email API
 * Vercel serverless function
 *
 * POST /api/email
 * Body: { to: string, videoTitle: string, places: [...] }
 * Sends a formatted email via Resend.
 */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { to, videoTitle, places } = req.body || {};

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  if (!Array.isArray(places) || places.length === 0) {
    return res.status(400).json({ error: "No places provided" });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: "Server not configured (missing RESEND_API_KEY)" });

  const html = buildEmailHTML(videoTitle, places);
  const text = buildEmailText(videoTitle, places);

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: "TripExtract <trips@xtractli.com>",
        to: [to],
        subject: `Your places from "${videoTitle || "YouTube video"}"`,
        html,
        text,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(502).json({ error: err.message || `Resend error ${resp.status}` });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error("[TripExtract] email error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ─── Email builders ───────────────────────────────────────────────────────────

function typeEmoji(type) {
  const map = {
    restaurant: "🍽️", cafe: "☕", bar: "🍸", hotel: "🏨",
    landmark: "🏛️", neighborhood: "🏘️", park: "🌿",
    market: "🛍️", museum: "🖼️", attraction: "⭐", other: "📍",
  };
  return map[type] || "📍";
}

function stars(rating) {
  if (!rating) return "";
  const full = Math.round(rating);
  return "★".repeat(full) + "☆".repeat(5 - full);
}

function buildEmailHTML(videoTitle, places) {
  const rows = places.map((p, i) => `
    <tr>
      <td style="padding: 16px 0; border-bottom: 1px solid #F0F0F0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="width: 32px; font-size: 20px; vertical-align: top; padding-top: 2px;">${typeEmoji(p.type)}</td>
            <td style="padding-left: 12px;">
              <div style="font-size: 16px; font-weight: 700; color: #1A1A1A; margin-bottom: 2px;">
                ${i + 1}. ${esc(p.name)}
              </div>
              ${p.address ? `<div style="font-size: 13px; color: #666; margin-bottom: 4px;">📍 ${esc(p.address)}</div>` : ""}
              ${p.rating ? `<div style="font-size: 13px; color: #F9A825; margin-bottom: 4px;">${stars(p.rating)} <span style="color: #666;">${p.rating.toFixed(1)}${p.userRatingCount ? ` (${p.userRatingCount.toLocaleString()})` : ""}</span></div>` : ""}
              ${p.knownFor ? `<div style="font-size: 13px; color: #444; margin-bottom: 8px;">${esc(p.knownFor)}</div>` : ""}
              <a href="${p.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}`}"
                 style="display: inline-block; background: #E8430A; color: white; text-decoration: none;
                        font-size: 12px; font-weight: 600; padding: 6px 14px; border-radius: 6px;">
                Open in Maps
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin: 0; padding: 0; background: #F5F5F5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: #F5F5F5; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background: #E8430A; padding: 24px 28px;">
              <div style="font-size: 20px; font-weight: 800; color: white; letter-spacing: -0.3px;">📍 TripExtract</div>
              <div style="font-size: 13px; color: rgba(255,255,255,0.85); margin-top: 4px;">
                ${places.length} place${places.length !== 1 ? "s" : ""} from <strong>${esc(videoTitle || "your video")}</strong>
              </div>
            </td>
          </tr>

          <!-- Places -->
          <tr>
            <td style="padding: 8px 28px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${rows}
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 16px 28px; background: #FAFAFA; border-top: 1px solid #F0F0F0;">
              <p style="font-size: 11px; color: #999; margin: 0; text-align: center;">
                Sent by <a href="https://tripextract.app" style="color: #E8430A; text-decoration: none;">TripExtract</a>
                · Places from YouTube travel videos
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildEmailText(videoTitle, places) {
  const lines = places.map((p, i) => {
    let line = `${i + 1}. ${typeEmoji(p.type)} ${p.name}`;
    if (p.address)   line += `\n   📍 ${p.address}`;
    if (p.rating)    line += `\n   ⭐ ${p.rating.toFixed(1)}${p.userRatingCount ? ` (${p.userRatingCount.toLocaleString()} reviews)` : ""}`;
    if (p.knownFor)  line += `\n   ${p.knownFor}`;
    if (p.mapsUrl)   line += `\n   ${p.mapsUrl}`;
    return line;
  });

  return [
    `📍 TripExtract — ${places.length} place${places.length !== 1 ? "s" : ""} from "${videoTitle || "your video"}"`,
    "",
    ...lines.flatMap((l) => [l, ""]),
    "—",
    "Sent by TripExtract · tripextract.app",
  ].join("\n");
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
