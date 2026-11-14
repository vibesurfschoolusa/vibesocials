import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rateLimit";

import { consumeGeocodeAppDay } from "./appDay";
import {
  GEOCODE_DAILY_LIMIT_CODE,
  GEOCODE_DAILY_LIMIT_MESSAGE,
  GEOCODE_UNAVAILABLE_CODE,
  GEOCODE_UNAVAILABLE_MESSAGE,
  GEOCODE_USER_LIMIT_CODE,
  GEOCODE_USER_LIMIT_MESSAGE,
} from "./limit";

// Minimal shape of a Google Geocoding API result (only the fields we read).
interface GeocodeResult {
  formatted_address: string;
  geometry: { location: { lat: number; lng: number } };
  place_id: string;
}

/**
 * Each lookup is a paid Google call and registration is open, so besides the
 * per-person limit there is one cap for the whole app per UTC day (F5, see
 * appDay.ts). The per-person limit fails open because the app-wide count fails
 * closed. Over either, the location box shows the sentence and keeps working
 * as plain text.
 */
const PER_USER_LIMIT = 30;
const PER_USER_WINDOW_MS = 5 * 60 * 1000;

function tooMany(error: string, retryAfterSeconds: number | undefined, code?: string): NextResponse {
  return NextResponse.json(
    { error, ...(code ? { code } : {}), retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds ?? 1) } },
  );
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "geocode",
    limit: PER_USER_LIMIT,
    windowMs: PER_USER_WINDOW_MS,
  });
  if (!rateLimit.allowed) {
    return tooMany(GEOCODE_USER_LIMIT_MESSAGE, rateLimit.retryAfterSeconds, GEOCODE_USER_LIMIT_CODE);
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

  // Counted only for a call that is really made.
  const appDay = await consumeGeocodeAppDay();
  if (appDay.outcome === "unavailable") {
    return NextResponse.json(
      { error: GEOCODE_UNAVAILABLE_MESSAGE, code: GEOCODE_UNAVAILABLE_CODE },
      { status: 503 },
    );
  }
  if (appDay.outcome === "limit") {
    return tooMany(GEOCODE_DAILY_LIMIT_MESSAGE, appDay.retryAfterSeconds, GEOCODE_DAILY_LIMIT_CODE);
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
