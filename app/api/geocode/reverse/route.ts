import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/api-utils";

const reverseGeocodeSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

function coordinateLabel(latitude: number, longitude: number) {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

export async function GET(request: NextRequest) {
  const authResult = await requireRole(request, ["DRIVER", "ADMIN", "TRANSPORTER"]);
  if (authResult.error) return authResult.error;

  const parsed = reverseGeocodeSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams)
  );

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  const { lat, lng } = parsed.data;
  const fallback = coordinateLabel(lat, lng);
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ location: fallback, source: "coordinates" });
  }

  try {
    const params = new URLSearchParams({
      latlng: `${lat},${lng}`,
      key: apiKey,
      result_type: "street_address|premise|route|locality|administrative_area_level_2",
    });
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`,
      { next: { revalidate: 86_400 } }
    );

    if (!response.ok) throw new Error(`Google Geocoding ${response.status}`);

    const payload = (await response.json()) as {
      status?: string;
      results?: Array<{ formatted_address?: string }>;
    };
    const location = payload.results?.find((result) => result.formatted_address)
      ?.formatted_address;

    return NextResponse.json({
      location: location ?? fallback,
      source: location ? "google-geocoding" : "coordinates",
    });
  } catch (error) {
    console.warn("Reverse geocoding unavailable:", error);
    return NextResponse.json({ location: fallback, source: "coordinates" });
  }
}
