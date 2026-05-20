import assert from "node:assert/strict";
import {
  buildAutoTrackingPayload,
  getAutoTrackableShipments,
} from "./driver-location-reporting";

const shipments = [
  { id: "created", status: "CREATED", vehicleId: "vehicle-1" },
  { id: "assigned", status: "ASSIGNED", vehicleId: "vehicle-1" },
  { id: "picked-up", status: "PICKED_UP", vehicleId: "vehicle-1" },
  { id: "in-transit", status: "IN_TRANSIT", vehicleId: "vehicle-2" },
  { id: "in-transit-no-vehicle", status: "IN_TRANSIT", vehicleId: null },
  { id: "delivered", status: "DELIVERED", vehicleId: "vehicle-3" },
];

assert.deepEqual(
  getAutoTrackableShipments(shipments).map((shipment) => shipment.id),
  ["picked-up", "in-transit"]
);

assert.deepEqual(
  buildAutoTrackingPayload({
    latitude: 12.9715987,
    longitude: 77.5945627,
  }),
  {
    location: "12.971599, 77.594563",
    latitude: 12.971599,
    longitude: 77.594563,
  }
);

assert.deepEqual(
  buildAutoTrackingPayload({
    latitude: 12.9715987,
    longitude: 77.5945627,
    location: "Bengaluru, Karnataka, India",
  }),
  {
    location: "Bengaluru, Karnataka, India",
    latitude: 12.971599,
    longitude: 77.594563,
  }
);
