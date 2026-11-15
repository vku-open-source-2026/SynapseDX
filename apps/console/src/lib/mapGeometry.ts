// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
const DEPTH: Record<string, number> = {Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3};
function position(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 2 && value.length <= 3 && value.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}
function coordinates(value: unknown, depth: number): boolean {
  if (depth === 0) return position(value);
  return Array.isArray(value) && value.length > 0 && value.length <= 10000 && value.every(item => coordinates(item, depth - 1));
}
function point(latValue: unknown, lngValue: unknown): GeoJSON.Point | null {
  if ([latValue, lngValue].some(value => value === null || value === undefined || value === '' || typeof value === 'boolean' || typeof value === 'object')) return null;
  const lat = Number(latValue), lng = Number(lngValue);
  return position([lng, lat]) ? {type:'Point', coordinates:[lng,lat]} : null;
}
/** Only finite WGS84 geometries. Missing/empty coordinates never become 0,0. */
export function recordGeometry(row: Record<string, unknown>): GeoJSON.Geometry | null {
  for (const field of ['geometry','geometry_json','location','current_location','current_location_json','coordinates','centroid']) {
    let value = row[field];
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { continue; } }
    if (Array.isArray(value) && position(value)) return {type:'Point',coordinates:value as number[]};
    if (!value || typeof value !== 'object') continue;
    let object = value as Record<string, unknown>;
    if (object.type === 'Feature') object = (object.geometry || {}) as Record<string, unknown>;
    const depth = DEPTH[String(object.type)];
    if (depth !== undefined && coordinates(object.coordinates, depth)) return {type:object.type, coordinates:object.coordinates} as GeoJSON.Geometry;
    const parsed = point(object.latitude ?? object.lat, object.longitude ?? object.lng ?? object.lon);
    if (parsed) return parsed;
  }
  return point(row.latitude, row.longitude);
}
