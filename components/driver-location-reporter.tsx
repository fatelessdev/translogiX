"use client";

import { useEffect, useRef } from "react";
import {
  buildAutoTrackingPayload,
  getAutoTrackableShipments,
} from "@/lib/driver-location-reporting";

type DriverShipmentForLocation = {
  id: string;
  status: string;
  vehicleId: string | null;
};

type DriverLocationReporterProps = {
  shipments?: DriverShipmentForLocation[];
};

async function fetchDriverShipments() {
  const response = await fetch("/api/driver/shipments", {
    credentials: "include",
  });

  if (!response.ok) return [];
  const payload = (await response.json()) as {
    shipments?: DriverShipmentForLocation[];
  };

  return payload.shipments ?? [];
}

async function postTrackingUpdate(
  shipmentId: string,
  payload: ReturnType<typeof buildAutoTrackingPayload>
) {
  const response = await fetch(`/api/driver/shipments/${shipmentId}/tracking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  return response.ok;
}

async function reverseGeocode(latitude: number, longitude: number) {
  const params = new URLSearchParams({
    lat: String(latitude),
    lng: String(longitude),
  });
  const response = await fetch(`/api/geocode/reverse?${params.toString()}`, {
    credentials: "include",
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as { location?: string };
  return payload.location ?? null;
}

export function DriverLocationReporter({
  shipments,
}: DriverLocationReporterProps) {
  const reportedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function reportLocation() {
      if (!navigator.geolocation) return;

      const sourceShipments = shipments ?? (await fetchDriverShipments());
      if (cancelled) return;

      const trackableShipments = getAutoTrackableShipments(sourceShipments);
      if (trackableShipments.length === 0) return;

      const signature = trackableShipments
        .map((shipment) => shipment.id)
        .sort()
        .join("|");
      if (reportedSignatureRef.current === signature) return;
      reportedSignatureRef.current = signature;

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          if (cancelled) return;

          const location = await reverseGeocode(
            position.coords.latitude,
            position.coords.longitude
          );
          if (cancelled) return;

          const payload = buildAutoTrackingPayload({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            location,
          });

          await Promise.allSettled(
            trackableShipments.map((shipment) =>
              postTrackingUpdate(shipment.id, payload)
            )
          );
        },
        () => {},
        {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 60_000,
        }
      );
    }

    reportLocation();

    return () => {
      cancelled = true;
    };
  }, [shipments]);

  return null;
}
