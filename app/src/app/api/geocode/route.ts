import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rateLimit";

// Minimal shape of a Google Geocoding API result (only the fields we read).
interface GeocodeResult {
  formatted_address: string;
  geometry: { location: { lat: number; lng: number } };
  place_id: string;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "geocode",
    limit: 60,
    windowMs: 5 * 60 * 1000,
    failClosed: true,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many requests. Please slow down.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) },
      },
    );
  }

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

    const suggestions = (data.results || []).slice(0, 5).map((result: GeocodeResult) => ({
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
