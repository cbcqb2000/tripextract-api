/**
 * TripExtract — Simple in-memory rate limiter
 *
 * Limits each IP to `maxRequests` calls per `windowMs` milliseconds.
 * Note: Vercel spins up multiple instances, so this is per-instance.
 * It's a meaningful abuse deterrent for casual misuse, not a hard cap.
 */

const store = new Map(); // ip → { count, resetAt }

const WINDOW_MS   = 60 * 1000; // 1 minute
const MAX_EXTRACT = 10;         // AI calls per IP per minute
const MAX_PLACES  = 60;         // Places lookups per IP per minute

function check(req, res, max) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const now = Date.now();
  const entry = store.get(ip);

  if (!entry || now > entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true; // allowed
  }

  if (entry.count >= max) {
    res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
    res.status(429).json({ error: "Too many requests — please wait a moment and try again." });
    return false; // blocked
  }

  entry.count++;
  return true; // allowed
}

// Prune stale entries every 5 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of store) {
    if (now > entry.resetAt) store.delete(ip);
  }
}, 5 * 60 * 1000);

module.exports = { check, MAX_EXTRACT, MAX_PLACES };
