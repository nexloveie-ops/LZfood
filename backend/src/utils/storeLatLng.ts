/** Parse restaurant_lat / restaurant_lng from SystemConfig key-value map. */
export function parseStoredRestaurantLatLng(
  map: Record<string, string | undefined>,
): { lat: number; lng: number } | null {
  const latRaw = (map.restaurant_lat ?? '').trim();
  const lngRaw = (map.restaurant_lng ?? '').trim();
  if (!latRaw || !lngRaw) return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
