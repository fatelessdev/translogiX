import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  routes,
  shipments,
  trackingUpdates,
  transporters,
  vehicles,
} from "@/lib/db/schema";
import { requireTransporterScope } from "@/lib/auth/api-utils";

type ShipmentStatus =
  | "CREATED"
  | "ASSIGNED"
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "CANCELLED";

const ACTIVE_STATUSES: ShipmentStatus[] = ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"];
const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const OPENWEATHER_URL = "https://api.openweathermap.org/data/2.5/weather";

function normalizedCity(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function numeric(value: string | number | null | undefined, fallback = 0) {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function coordinate(value: string | number | null | undefined) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function present<T>(value: T | null | undefined): value is T {
  return value != null;
}

function daysBetween(from: Date, to: Date) {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function maintenanceRiskScore(
  lastMaintenanceDate: string | null,
  activeLoad: number,
  status: string
) {
  if (!lastMaintenanceDate) return null;

  const lastMaintenance = new Date(`${lastMaintenanceDate}T00:00:00`);
  const daysSinceMaintenance = Math.max(0, daysBetween(lastMaintenance, new Date()));
  const statusPenalty = status === "MAINTENANCE" ? 35 : status === "BUSY" ? 10 : 0;

  return Math.min(
    100,
    Math.round(daysSinceMaintenance * 0.28 + activeLoad * 18 + statusPenalty)
  );
}

interface RoutePoint {
  address?: string;
  latitude?: number;
  longitude?: number;
}

interface TrafficProfile {
  multiplier: number;
  level: string;
  durationHours: number;
  staticDurationHours: number;
  distanceKm: number;
  source: "google-routes";
}

interface WeatherProfile {
  delayHours: number;
  condition: string;
  temperatureC: number | null;
  windKph: number | null;
  source: "openweather";
}

function durationToHours(duration: string | undefined) {
  if (!duration) return null;
  const seconds = Number.parseFloat(duration.replace("s", ""));
  return Number.isFinite(seconds) ? seconds / 3600 : null;
}

function trafficLevel(multiplier: number) {
  return multiplier >= 1.35 ? "Heavy" : multiplier >= 1.15 ? "Moderate" : "Light";
}

function googleRouteWaypoint(point: RoutePoint) {
  if (point.latitude != null && point.longitude != null) {
    return {
      location: {
        latLng: {
          latitude: point.latitude,
          longitude: point.longitude,
        },
      },
    };
  }

  return { address: `${point.address}, India` };
}

async function getTrafficProfile(
  origin: RoutePoint,
  destination: string,
  distanceKm: number
): Promise<TrafficProfile | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) return null;

  try {
    const response = await fetch(GOOGLE_ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: googleRouteWaypoint(origin),
        destination: { address: `${destination}, India` },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE_OPTIMAL",
        departureTime: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });

    if (!response.ok) throw new Error(`Google Routes ${response.status}`);

    const payload = (await response.json()) as {
      routes?: Array<{
        duration?: string;
        staticDuration?: string;
        distanceMeters?: number;
      }>;
    };
    const route = payload.routes?.[0];
    const durationHours = durationToHours(route?.duration);
    const staticDurationHours = durationToHours(route?.staticDuration);

    if (!route || !durationHours || !staticDurationHours) {
      throw new Error("Google Routes returned incomplete traffic data");
    }

    const multiplier = Number(
      Math.max(1, durationHours / Math.max(0.1, staticDurationHours)).toFixed(2)
    );

    return {
      multiplier,
      level: trafficLevel(multiplier),
      durationHours,
      staticDurationHours,
      distanceKm: route.distanceMeters ? route.distanceMeters / 1000 : distanceKm,
      source: "google-routes",
    };
  } catch (error) {
    console.warn("Google Routes live traffic unavailable:", error);
    return null;
  }
}

async function getWeatherProfile(destination: string): Promise<WeatherProfile | null> {
  const apiKey = process.env.OPENWEATHER_API_KEY;

  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      q: `${destination},IN`,
      appid: apiKey,
      units: "metric",
    });
    const response = await fetch(`${OPENWEATHER_URL}?${params.toString()}`, {
      next: { revalidate: 300 },
    });

    if (!response.ok) throw new Error(`OpenWeather ${response.status}`);

    const payload = (await response.json()) as {
      weather?: Array<{ main?: string; description?: string }>;
      main?: { temp?: number };
      wind?: { speed?: number };
    };
    const weather = payload.weather?.[0];
    if (!weather?.main) throw new Error("OpenWeather returned no condition");

    const main = weather.main;
    const description = weather.description ?? main;
    const windKph = payload.wind?.speed != null ? payload.wind.speed * 3.6 : null;
    const temp = payload.main?.temp ?? null;
    const weatherDelay =
      ["Thunderstorm", "Rain", "Snow"].includes(main)
        ? 3
        : main === "Drizzle" || main === "Mist" || main === "Fog"
          ? 2
          : windKph && windKph > 35
            ? 1
            : 0;

    return {
      delayHours: weatherDelay,
      condition: description,
      temperatureC: temp,
      windKph,
      source: "openweather",
    };
  } catch (error) {
    console.warn("OpenWeather live weather unavailable:", error);
    return null;
  }
}

async function routeScore(route: {
  origin: string;
  destination: string;
  distanceKm: string;
}) {
  const distanceKm = numeric(route.distanceKm);
  const [traffic, weather] = await Promise.all([
    getTrafficProfile({ address: route.origin }, route.destination, distanceKm),
    getWeatherProfile(route.destination),
  ]);
  if (!traffic || !weather) return null;

  const predictedHours = Math.round(traffic.durationHours + weather.delayHours);

  return {
    distanceKm: traffic.distanceKm,
    traffic,
    weather,
    predictedHours,
    score: predictedHours + traffic.distanceKm / 120,
  };
}

export async function GET(request: NextRequest) {
  const authResult = await requireTransporterScope(request);
  if (authResult.error) return authResult.error;

  try {
    const shipmentConditions = authResult.transporterId
      ? [eq(shipments.transporterId, authResult.transporterId)]
      : [];
    const vehicleConditions = authResult.transporterId
      ? [eq(vehicles.transporterId, authResult.transporterId)]
      : [];

    const [shipmentRows, vehicleRows, routeRows, updateRows] = await Promise.all([
      db
        .select({
          id: shipments.id,
          packageCode: shipments.packageCode,
          source: shipments.source,
          destination: shipments.destination,
          grossWeightKg: shipments.grossWeightKg,
          pickupDate: shipments.pickupDate,
          deliveryDeadline: shipments.deliveryDeadline,
          transporterId: shipments.transporterId,
          vehicleId: shipments.vehicleId,
          routeId: shipments.routeId,
          status: shipments.status,
          transporterName: transporters.name,
          vehicleNumber: vehicles.vehicleNumber,
          routeOrigin: routes.origin,
          routeDestination: routes.destination,
          routeDistanceKm: routes.distanceKm,
        })
        .from(shipments)
        .leftJoin(transporters, eq(shipments.transporterId, transporters.id))
        .leftJoin(vehicles, eq(shipments.vehicleId, vehicles.id))
        .leftJoin(routes, eq(shipments.routeId, routes.id))
        .where(shipmentConditions.length ? and(...shipmentConditions) : undefined)
        .orderBy(desc(shipments.createdAt)),
      db
        .select({
          id: vehicles.id,
          vehicleNumber: vehicles.vehicleNumber,
          transporterId: vehicles.transporterId,
          transporterName: transporters.name,
          vehicleType: vehicles.vehicleType,
          capacityKg: vehicles.capacityKg,
          currentLocation: vehicles.currentLocation,
          status: vehicles.status,
          lastMaintenanceDate: vehicles.lastMaintenanceDate,
        })
        .from(vehicles)
        .innerJoin(transporters, eq(vehicles.transporterId, transporters.id))
        .where(vehicleConditions.length ? and(...vehicleConditions) : undefined)
        .orderBy(desc(vehicles.createdAt)),
      db.select().from(routes).orderBy(desc(routes.createdAt)),
      db
        .select({
          id: trackingUpdates.id,
          shipmentId: trackingUpdates.shipmentId,
          location: trackingUpdates.location,
          latitude: trackingUpdates.latitude,
          longitude: trackingUpdates.longitude,
          createdAt: trackingUpdates.createdAt,
        })
        .from(trackingUpdates)
        .orderBy(desc(trackingUpdates.createdAt)),
    ]);

    const latestUpdateByShipment = new Map<string, (typeof updateRows)[number]>();
    for (const update of updateRows) {
      if (!latestUpdateByShipment.has(update.shipmentId)) {
        latestUpdateByShipment.set(update.shipmentId, update);
      }
    }

    const activeShipments = shipmentRows.filter((shipment) =>
      ACTIVE_STATUSES.includes(shipment.status as ShipmentStatus)
    );

    const liveTracking = activeShipments.map((shipment) => {
      const latestUpdate = latestUpdateByShipment.get(shipment.id);
      const latitude = coordinate(latestUpdate?.latitude);
      const longitude = coordinate(latestUpdate?.longitude);

      if (
        !latestUpdate ||
        latitude == null ||
        longitude == null ||
        !shipment.vehicleNumber ||
        !shipment.transporterName
      ) {
        return null;
      }

      return {
        shipmentId: shipment.id,
        packageCode: shipment.packageCode,
        status: shipment.status,
        vehicleNumber: shipment.vehicleNumber,
        transporterName: shipment.transporterName,
        location: latestUpdate.location,
        latitude,
        longitude,
        updatedAt: latestUpdate.createdAt,
      };
    }).filter(present);

    const liveRouteInputsAvailable =
      Boolean(process.env.GOOGLE_MAPS_API_KEY) &&
      Boolean(process.env.OPENWEATHER_API_KEY);

    const routeRecommendations = liveRouteInputsAvailable
      ? (
          await Promise.all(
            activeShipments.map(async (shipment) => {
              const candidates = routeRows
                .filter((route) => {
                  const sameEndpoint =
                    normalizedCity(route.origin) === normalizedCity(shipment.source) ||
                    normalizedCity(route.destination) ===
                      normalizedCity(shipment.destination);
                  return sameEndpoint || route.id === shipment.routeId;
                })
                .slice(0, 6);

              const scoredRoutes = (
                await Promise.all(
                  (candidates.length ? candidates : routeRows.slice(0, 6)).map(
                    async (route) => {
                      const analysis = await routeScore(route);
                      return analysis ? { route, analysis } : null;
                    }
                  )
                )
              )
                .filter(present)
                .sort((a, b) => a.analysis.score - b.analysis.score);

              const best = scoredRoutes[0];
              const current = scoredRoutes.find(({ route }) => route.id === shipment.routeId);
              const currentHours = current?.analysis.predictedHours ?? null;
              const savedHours =
                currentHours && best
                  ? Math.max(0, currentHours - best.analysis.predictedHours)
                  : 0;

              if (!best || !current || !currentHours) return null;
              const recommended = savedHours > 0 ? best : current;

              return {
                shipmentId: shipment.id,
                packageCode: shipment.packageCode,
                recommendedRouteId: savedHours > 0 ? recommended.route.id : null,
                currentRoute: shipment.routeOrigin
                  ? `${shipment.routeOrigin} to ${shipment.routeDestination}`
                  : `${shipment.source} to ${shipment.destination}`,
                recommendedRoute: `${recommended.route.origin} to ${recommended.route.destination}`,
                trafficLevel: recommended.analysis.traffic.level,
                weatherCondition: recommended.analysis.weather.condition,
                predictedHours: recommended.analysis.predictedHours,
                trafficSource: recommended.analysis.traffic.source,
                weatherSource: recommended.analysis.weather.source,
                distanceKm: Math.round(recommended.analysis.distanceKm),
                savedHours,
                reason:
                  savedHours > 0
                    ? "Lower live traffic and weather-adjusted ETA than the assigned route."
                    : "Assigned route has the best live ETA among known routes.",
              };
            })
          )
        ).filter(present)
      : [];

    const vehicleLoad = new Map<string, number>();
    for (const shipment of activeShipments) {
      if (shipment.vehicleId) {
        vehicleLoad.set(shipment.vehicleId, (vehicleLoad.get(shipment.vehicleId) ?? 0) + 1);
      }
    }

    const maintenancePredictions = vehicleRows.map((vehicle) => {
      const activeLoad = vehicleLoad.get(vehicle.id) ?? 0;
      const riskScore = maintenanceRiskScore(
        vehicle.lastMaintenanceDate,
        activeLoad,
        vehicle.status
      );
      if (riskScore == null || !vehicle.lastMaintenanceDate) return null;

      return {
        vehicleId: vehicle.id,
        vehicleNumber: vehicle.vehicleNumber,
        status: vehicle.status,
        activeLoad,
        daysSinceMaintenance: Math.max(
          0,
          daysBetween(new Date(`${vehicle.lastMaintenanceDate}T00:00:00`), new Date())
        ),
        riskScore,
        riskLevel: riskScore >= 75 ? "High" : riskScore >= 45 ? "Medium" : "Low",
        recommendation:
          riskScore >= 75
            ? "Schedule maintenance before assigning another long-haul shipment."
            : riskScore >= 45
              ? "Inspect tyres, oil, brakes, and coolant on the next depot stop."
              : "No immediate maintenance action required.",
      };
    }).filter(present);

    const delayPredictions = liveRouteInputsAvailable
      ? (
          await Promise.all(
            activeShipments.map(async (shipment) => {
              const latestUpdate = latestUpdateByShipment.get(shipment.id);
              const latitude = coordinate(latestUpdate?.latitude);
              const longitude = coordinate(latestUpdate?.longitude);
              if (latitude == null || longitude == null) return null;

              const traffic = await getTrafficProfile(
                { latitude, longitude },
                shipment.destination,
                numeric(shipment.routeDistanceKm)
              );
              const weather = await getWeatherProfile(shipment.destination);
              if (!traffic || !weather) return null;

              const remainingKm = traffic.distanceKm;
              const etaHours = Math.round(traffic.durationHours + weather.delayHours);
              const predictedDelivery = new Date(Date.now() + etaHours * 3_600_000);
              const deadline = new Date(`${shipment.deliveryDeadline}T23:59:59`);
              const delayHours = Math.max(
                0,
                Math.ceil(
                  (predictedDelivery.getTime() - deadline.getTime()) / 3_600_000
                )
              );

              return {
                shipmentId: shipment.id,
                packageCode: shipment.packageCode,
                status: shipment.status,
                destination: shipment.destination,
                etaHours,
                predictedDelivery: predictedDelivery.toISOString(),
                deadline: deadline.toISOString(),
                delayHours,
                riskLevel: delayHours >= 12 ? "High" : delayHours > 0 ? "Medium" : "Low",
                factors: [
                  latestUpdate?.location
                    ? `Current location: ${latestUpdate.location}`
                    : `Current coordinates: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
                  `${traffic.level} traffic`,
                  weather.condition,
                  `${Math.round(remainingKm)} km remaining`,
                  "Google traffic",
                  "Live weather",
                ],
              };
            })
          )
        ).filter(present)
      : [];

    const optimizationSuggestions = await Promise.all(
      shipmentRows
        .filter((shipment) => shipment.status === "CREATED" && !shipment.vehicleId)
        .slice(0, 6)
        .map((shipment) => {
          const weightKg = numeric(shipment.grossWeightKg);
          const bestVehicle = vehicleRows
            .map((vehicle) => {
              if (vehicle.status !== "AVAILABLE" || vehicle.capacityKg < weightKg) {
                return null;
              }
              const capacityFit = Math.max(
                0,
                100 - ((vehicle.capacityKg - weightKg) / vehicle.capacityKg) * 100
              );
              const activeLoad = vehicleLoad.get(vehicle.id) ?? 0;
              const riskScore =
                maintenanceRiskScore(vehicle.lastMaintenanceDate, activeLoad, vehicle.status) ?? 0;
              const score = Math.round(Math.max(0, capacityFit - riskScore * 0.35));
              return { vehicle, score };
            })
            .filter(Boolean)
            .sort((a, b) => (b?.score ?? 0) - (a?.score ?? 0))[0];

          const route = routeRows
            .filter((candidate) => {
              const sameEndpoint =
                normalizedCity(candidate.origin) === normalizedCity(shipment.source) ||
                normalizedCity(candidate.destination) === normalizedCity(shipment.destination);
              return sameEndpoint;
            })
            .sort((a, b) => numeric(a.distanceKm) - numeric(b.distanceKm))[0];

          if (!bestVehicle || !route) return null;

          return {
            shipmentId: shipment.id,
            packageCode: shipment.packageCode,
            recommendedVehicleId: bestVehicle.vehicle.id,
            recommendedRouteId: route.id,
            recommendedVehicle: bestVehicle.vehicle.vehicleNumber,
            recommendedRoute: `${route.origin} to ${route.destination}`,
            confidence: bestVehicle.score,
            reason: "Best capacity fit after maintenance risk and current availability scoring.",
          };
        })
    ).then((items) => items.filter(present));

    const highDelayCount = delayPredictions.filter((item) => item.riskLevel === "High").length;
    const highMaintenanceCount = maintenancePredictions.filter((item) => item.riskLevel === "High").length;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      integrations: {
        googleMapsBrowser: Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY),
        googleRoutesTraffic: Boolean(process.env.GOOGLE_MAPS_API_KEY),
        openWeather: Boolean(process.env.OPENWEATHER_API_KEY),
      },
      summary: {
        activeShipments: activeShipments.length,
        trackedVehicles: liveTracking.length,
        rerouteSuggestions: routeRecommendations.filter((item) => item.savedHours > 0).length,
        highDelayCount,
        highMaintenanceCount,
      },
      liveTracking,
      routeRecommendations,
      optimizationSuggestions,
      delayPredictions,
      maintenancePredictions,
    });
  } catch (error) {
    console.error("Error building operations intelligence:", error);
    return NextResponse.json(
      { error: "Failed to build operations intelligence" },
      { status: 500 }
    );
  }
}
