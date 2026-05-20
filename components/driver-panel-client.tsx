"use client";

import { useState, useEffect } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Search,
  RefreshCw,
  AlertTriangle,
  Package,
  MapPin,
  LocateFixed,
  Truck,
  CheckCircle,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { useDebounce } from "@/lib/hooks/use-debounce";
import {
  STATUS_BADGE_COLORS,
  VALID_STATUS_TRANSITIONS,
} from "@/lib/validations";
import { DriverLocationReporter } from "@/components/driver-location-reporter";

interface Shipment {
  id: string;
  packageCode: string;
  source: string;
  destination: string;
  materialType: string;
  grossWeightKg: string;
  quantity: number;
  pickupDate: string;
  deliveryDeadline: string;
  transporterId: string | null;
  vehicleId: string | null;
  routeId: string | null;
  status:
    | "CREATED"
    | "ASSIGNED"
    | "PICKED_UP"
    | "IN_TRANSIT"
    | "DELIVERED"
    | "CANCELLED";
  createdAt: string;
  updatedAt: string;
  transporterName: string | null;
  vehicleNumber: string | null;
}

interface LocationFormState {
  location: string;
  latitude: string;
  longitude: string;
}

interface LocationFormErrors {
  location?: string;
  latitude?: string;
  longitude?: string;
}

const initialLocationForm: LocationFormState = {
  location: "",
  latitude: "",
  longitude: "",
};

export function DriverPanelClient() {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const debouncedSearch = useDebounce(search, 300);

  // Status update state
  const [statusUpdating, setStatusUpdating] = useState<string | null>(null);

  // Location update state
  const [selectedShipmentForTracking, setSelectedShipmentForTracking] =
    useState<string | null>(null);
  const [locationForm, setLocationForm] = useState<LocationFormState>(
    initialLocationForm
  );
  const [locationErrors, setLocationErrors] = useState<LocationFormErrors>({});
  const [locationSubmitting, setLocationSubmitting] = useState(false);
  const [locating, setLocating] = useState(false);

  // Mark as delivered state
  const [deliveredDialog, setDeliveredDialog] = useState<Shipment | null>(null);
  const [deliveredConfirmText, setDeliveredConfirmText] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadShipments() {
      try {
        setLoading(true);
        setError(null);
        const params = new URLSearchParams();
        if (debouncedSearch) params.set("search", debouncedSearch);

        const response = await fetch(
          `/api/driver/shipments?${params.toString()}`,
          { credentials: "include" }
        );

        if (cancelled) return;

        if (!response.ok) {
          throw new Error("Failed to fetch shipments");
        }

        const data = await response.json();
        if (!cancelled) {
          setShipments(data.shipments);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "An unexpected error occurred"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadShipments();

    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, retryKey]);

  const handleRetry = () => {
    setRetryKey((k) => k + 1);
  };

  // ─── Status Update ────────────────────────────────────────────────

  const handleStatusChange = async (
    shipment: Shipment,
    newStatus: string | null
  ) => {
    if (!newStatus) return;
    setStatusUpdating(shipment.id);

    try {
      const response = await fetch(
        `/api/driver/shipments/${shipment.id}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status: newStatus }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to update status");
      }

      const data = await response.json();

      setShipments((prev) =>
        prev.map((s) =>
          s.id === shipment.id
            ? { ...s, status: data.shipment.status as Shipment["status"] }
            : s
        )
      );

      toast.success(
        `Shipment "${shipment.packageCode}" status changed to ${newStatus.replace("_", " ")}`
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update status"
      );
    } finally {
      setStatusUpdating(null);
    }
  };

  // ─── Mark as Delivered ────────────────────────────────────────────

  const handleMarkAsDelivered = async () => {
    if (!deliveredDialog) return;

    setStatusUpdating(deliveredDialog.id);

    try {
      const response = await fetch(
        `/api/driver/shipments/${deliveredDialog.id}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status: "DELIVERED" }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to mark as delivered");
      }

      const data = await response.json();

      setShipments((prev) =>
        prev.map((s) =>
          s.id === deliveredDialog.id
            ? { ...s, status: data.shipment.status as Shipment["status"] }
            : s
        )
      );

      toast.success(
        `Shipment "${deliveredDialog.packageCode}" marked as delivered!`
      );
      setDeliveredDialog(null);
      setDeliveredConfirmText("");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to mark as delivered"
      );
    } finally {
      setStatusUpdating(null);
    }
  };

  // ─── Location Update ──────────────────────────────────────────────

  const validateLocationForm = (): boolean => {
    const errors: LocationFormErrors = {};

    if (!locationForm.location.trim()) {
      errors.location = "Location text is required";
    }

    if (locationForm.latitude.trim() !== "") {
      const lat = parseFloat(locationForm.latitude);
      if (isNaN(lat) || lat < -90 || lat > 90) {
        errors.latitude = "Latitude must be between -90 and 90";
      }
    }

    if (locationForm.longitude.trim() !== "") {
      const lng = parseFloat(locationForm.longitude);
      if (isNaN(lng) || lng < -180 || lng > 180) {
        errors.longitude = "Longitude must be between -180 and 180";
      }
    }

    setLocationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleLocationSubmit = async (shipmentId: string) => {
    if (!validateLocationForm()) return;

    setLocationSubmitting(true);

    try {
      const body: Record<string, unknown> = {
        location: locationForm.location.trim(),
      };

      if (locationForm.latitude.trim() !== "") {
        body.latitude = parseFloat(locationForm.latitude);
      }
      if (locationForm.longitude.trim() !== "") {
        body.longitude = parseFloat(locationForm.longitude);
      }

      const response = await fetch(
        `/api/driver/shipments/${shipmentId}/tracking`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to add location update");
      }

      toast.success("Location update added successfully!");
      setSelectedShipmentForTracking(null);
      setLocationForm(initialLocationForm);
      setLocationErrors({});
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to add location update"
      );
    } finally {
      setLocationSubmitting(false);
    }
  };

  const handleUseCurrentGps = () => {
    if (!navigator.geolocation) {
      toast.error("GPS is not available in this browser.");
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocationForm((prev) => ({
          location: prev.location.trim() || "Current GPS location",
          latitude: position.coords.latitude.toFixed(6),
          longitude: position.coords.longitude.toFixed(6),
        }));
        setLocationErrors((prev) => ({
          ...prev,
          latitude: undefined,
          longitude: undefined,
        }));
        setLocating(false);
        toast.success("Current GPS coordinates added.");
      },
      (geoError) => {
        setLocating(false);
        toast.error(
          geoError.message || "Allow location access to use current GPS."
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 30_000,
      }
    );
  };

  const openTrackingForm = (shipmentId: string) => {
    setSelectedShipmentForTracking(shipmentId);
    setLocationForm(initialLocationForm);
    setLocationErrors({});
  };

  const closeTrackingForm = () => {
    setSelectedShipmentForTracking(null);
    setLocationForm(initialLocationForm);
    setLocationErrors({});
  };

  // ─── Render ───────────────────────────────────────────────────────

  if (loading) {
    return <DriverPanelSkeleton />;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">Failed to load shipments</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button onClick={handleRetry} variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DriverLocationReporter shipments={shipments} />

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">My Shipments</h1>
        <p className="text-muted-foreground">
          View and manage shipments assigned to your transporter
        </p>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by package code, source, or destination..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {/* Shipments Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Package Code</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Vehicle</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shipments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  {search
                    ? "No shipments match your search."
                    : "No shipments assigned to you."}
                </TableCell>
              </TableRow>
            ) : (
              shipments.map((shipment) => {
                const validNext =
                  VALID_STATUS_TRANSITIONS[shipment.status] || [];
                const isTerminal = validNext.length === 0;
                const isUpdating = statusUpdating === shipment.id;
                const isAssigned = shipment.status === "ASSIGNED";
                const isPickedUp = shipment.status === "PICKED_UP";
                const isInTransit = shipment.status === "IN_TRANSIT";
                const isDelivered = shipment.status === "DELIVERED";
                const isCancelled = shipment.status === "CANCELLED";
                const canAddTracking = !isDelivered && !isCancelled;

                return (
                  <TableRow key={shipment.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-muted-foreground" />
                        {shipment.packageCode}
                      </div>
                    </TableCell>
                    <TableCell>{shipment.source}</TableCell>
                    <TableCell>{shipment.destination}</TableCell>
                    <TableCell>
                      {isTerminal ? (
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_COLORS[shipment.status]}`}
                        >
                          {shipment.status.replace("_", " ")}
                        </span>
                      ) : (
                        <Select
                          value={shipment.status}
                          onValueChange={(value) =>
                            handleStatusChange(shipment, value)
                          }
                          disabled={isUpdating}
                        >
                          <SelectTrigger className="w-[160px]">
                            <SelectValue>
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_COLORS[shipment.status]}`}
                              >
                                {shipment.status.replace("_", " ")}
                              </span>
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={shipment.status} disabled>
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_COLORS[shipment.status]}`}
                              >
                                {shipment.status.replace("_", " ")}
                              </span>
                            </SelectItem>
                            {validNext.map((status) => (
                              <SelectItem key={status} value={status}>
                                <span
                                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_COLORS[status]}`}
                                >
                                  {status.replace("_", " ")}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Truck className="h-4 w-4 text-muted-foreground" />
                        {shipment.vehicleNumber || "Not assigned"}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {isAssigned && (
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => handleStatusChange(shipment, "PICKED_UP")}
                            disabled={isUpdating}
                          >
                            <Package className="mr-1.5 h-3.5 w-3.5" />
                            Mark Picked Up
                          </Button>
                        )}
                        {isPickedUp && (
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => handleStatusChange(shipment, "IN_TRANSIT")}
                            disabled={isUpdating}
                          >
                            <Truck className="mr-1.5 h-3.5 w-3.5" />
                            Start Transit
                          </Button>
                        )}
                        {canAddTracking && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openTrackingForm(shipment.id)}
                          >
                            <MapPin className="mr-1.5 h-3.5 w-3.5" />
                            Location
                          </Button>
                        )}
                        {isInTransit && (
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => setDeliveredDialog(shipment)}
                            disabled={isUpdating}
                          >
                            <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                            Mark Delivered
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* ─── Location Update Dialog ─────────────────────────────────── */}
      <Dialog
        open={!!selectedShipmentForTracking}
        onOpenChange={(open) => {
          if (!open) closeTrackingForm();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Location Update</DialogTitle>
            <DialogDescription>
              Add the shipment location manually or use this device&apos;s GPS.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2"
              onClick={handleUseCurrentGps}
              disabled={locating || locationSubmitting}
            >
              <LocateFixed className="h-4 w-4" />
              {locating ? "Reading GPS..." : "Use Current GPS"}
            </Button>
            <div className="space-y-2">
              <Label htmlFor="location">
                Location <span className="text-destructive">*</span>
              </Label>
              <Input
                id="location"
                placeholder="e.g. Arrived at Dallas distribution center"
                value={locationForm.location}
                onChange={(e) =>
                  setLocationForm((prev) => ({
                    ...prev,
                    location: e.target.value,
                  }))
                }
                aria-invalid={!!locationErrors.location}
              />
              {locationErrors.location && (
                <p className="text-sm text-destructive">
                  {locationErrors.location}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="latitude">Latitude (optional)</Label>
                <Input
                  id="latitude"
                  type="number"
                  step="any"
                  placeholder="-90 to 90"
                  value={locationForm.latitude}
                  onChange={(e) =>
                    setLocationForm((prev) => ({
                      ...prev,
                      latitude: e.target.value,
                    }))
                  }
                  aria-invalid={!!locationErrors.latitude}
                />
                {locationErrors.latitude && (
                  <p className="text-sm text-destructive">
                    {locationErrors.latitude}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="longitude">Longitude (optional)</Label>
                <Input
                  id="longitude"
                  type="number"
                  step="any"
                  placeholder="-180 to 180"
                  value={locationForm.longitude}
                  onChange={(e) =>
                    setLocationForm((prev) => ({
                      ...prev,
                      longitude: e.target.value,
                    }))
                  }
                  aria-invalid={!!locationErrors.longitude}
                />
                {locationErrors.longitude && (
                  <p className="text-sm text-destructive">
                    {locationErrors.longitude}
                  </p>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeTrackingForm}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selectedShipmentForTracking) {
                  handleLocationSubmit(selectedShipmentForTracking);
                }
              }}
              disabled={locationSubmitting}
            >
              {locationSubmitting ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Submit Update
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Mark as Delivered Confirmation Dialog ──────────────────── */}
      <Dialog
        open={!!deliveredDialog}
        onOpenChange={(open) => {
          if (!open) {
            setDeliveredDialog(null);
            setDeliveredConfirmText("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Delivery</DialogTitle>
            <DialogDescription>
              Are you sure you want to mark shipment{" "}
              <strong>{deliveredDialog?.packageCode}</strong> as delivered? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="confirm-delivered">
              Type <strong>DELIVER</strong> to confirm
            </Label>
            <Input
              id="confirm-delivered"
              placeholder="Type DELIVER"
              value={deliveredConfirmText}
              onChange={(e) => setDeliveredConfirmText(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeliveredDialog(null);
                setDeliveredConfirmText("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={handleMarkAsDelivered}
              disabled={
                deliveredConfirmText !== "DELIVER" || statusUpdating !== null
              }
            >
              {statusUpdating === deliveredDialog?.id ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Confirming...
                </>
              ) : (
                <>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Mark as Delivered
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────

function DriverPanelSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-9 w-72" />
      <div className="rounded-md border">
        <div className="space-y-0">
          <div className="flex h-10 items-center gap-4 border-b px-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-4 flex-1" />
            ))}
          </div>
          {[1, 2, 3].map((row) => (
            <div
              key={row}
              className="flex h-14 items-center gap-4 px-4 border-b last:border-0"
            >
              {[1, 2, 3, 4, 5, 6].map((col) => (
                <Skeleton key={col} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
