import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query");

  if (!query || query.trim().length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.error("[Geocode] GOOGLE_MAPS_API_KEY not configured");
    return NextResponse.json(
      { error: "Geocoding not configured" },
      { status: 500 },
    );
  }

  try {
    // Use Geocoding API to search for locations
    const geocodeUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    geocodeUrl.searchParams.set("address", query);
    geocodeUrl.searchParams.set("key", apiKey);

    const response = await fetch(geocodeUrl.toString());

    if (!response.ok) {
      console.error("[Geocode] API request failed", response.status);
      return NextResponse.json(
        { error: "Geocoding request failed" },
        { status: response.status },
      );
    }

    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("[Geocode] API error", data.status, data.error_message);
      return NextResponse.json(
        { error: `Geocoding error: ${data.status}` },
        { status: 400 },
      );
    }

    // Format results for frontend
    const suggestions = (data.results || []).slice(0, 5).map((result: any) => ({
      description: result.formatted_address,
      latitude: result.geometry.location.lat,
      longitude: result.geometry.location.lng,
      placeId: result.place_id,
    }));

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error("[Geocode] Unexpected error", error);
    return NextResponse.json(
      { error: "Failed to geocode location" },
      { status: 500 },
    );
  }
}
