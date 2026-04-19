/**
 * TripExtract — Places API
 * Vercel serverless function
 *
 * POST /api/places
 * Body: { name: string, city: string }
 * Returns: { address, placeId, lat, lng, rating, userRatingCount, photoRef, mapsUrl }
 *
 * Calls Google Places API (New) on the server — API key stays private.
 */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, city } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Missing or invalid name" });
  }

  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!placesKey) return res.status(500).json({ error: "Server not configured (missing GOOGLE_PLACES_API_KEY)" });

  const query = [name, city].filter(Boolean).join(", ");

  try {
    // Step 1: Text Search to get place ID + basic info
    const searchResp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": placesKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress," +
          "places.location,places.rating,places.userRatingCount," +
          "places.photos,places.googleMapsUri",
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    });

    if (!searchResp.ok) {
      const err = await searchResp.json().catch(() => ({}));
      return res.status(502).json({ error: err.error?.message || `Places search error ${searchResp.status}` });
    }

    const searchData = await searchResp.json();
    const result = searchData.places?.[0];
    if (!result) return res.status(404).json({ error: `No Places result for "${query}"` });

    const placeId = result.id;

    return res.status(200).json({
      address:         result.formattedAddress || "",
      placeId,
      lat:             result.location?.latitude  || null,
      lng:             result.location?.longitude || null,
      rating:          result.rating             || null,
      userRatingCount: result.userRatingCount    || null,
      photoRef:        result.photos?.[0]?.name  || null,
      mapsUrl:         result.googleMapsUri      || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
    });
  } catch (e) {
    console.error("[TripExtract] places error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
