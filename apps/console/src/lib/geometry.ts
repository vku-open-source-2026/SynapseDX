// SPDX-License-Identifier: Apache-2.0
/** Bounded WGS84 geometry validation shared with the native editor. */
export function geometryError(value: unknown): string | null {
  let positions = 0;
  const point = (v: any): boolean => Array.isArray(v) && v.length >= 2 && v.length <= 3 && v.every((n: any) => typeof n === "number" && Number.isFinite(n)) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90 && ++positions <= 5000;
  const line = (v: any, min: number): boolean => Array.isArray(v) && v.length >= min && v.length <= 5000 && v.every(point);
  const ring = (v: any): boolean => line(v, 4) && JSON.stringify(v[0]) === JSON.stringify(v[v.length - 1]);
  const polygon = (v: any): boolean => Array.isArray(v) && v.length >= 1 && v.length <= 100 && v.every(ring);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Choose a GeoJSON geometry";
  const g = value as any;
  if (Object.keys(g).some(k => !["type", "coordinates", "bbox"].includes(k))) return "Use a geometry object with type and coordinates";
  let valid = false;
  switch (g.type) {
    case "Point": valid = point(g.coordinates); break;
    case "MultiPoint": valid = line(g.coordinates, 1); break;
    case "LineString": valid = line(g.coordinates, 2); break;
    case "MultiLineString": valid = Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.length <= 100 && g.coordinates.every((v: any) => line(v, 2)); break;
    case "Polygon": valid = polygon(g.coordinates); break;
    case "MultiPolygon": valid = Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.length <= 100 && g.coordinates.every(polygon); break;
    default: return "Supported geometry types: Point, LineString, Polygon and their Multi variants";
  }
  if (g.bbox !== undefined && (!Array.isArray(g.bbox) || ![4, 6].includes(g.bbox.length) || !g.bbox.every((n: any) => typeof n === "number" && Number.isFinite(n)))) return "Invalid geometry bounding box";
  return valid ? null : "Use finite WGS84 coordinates, at most 5000 positions, two or more line points and closed polygon rings with at least four positions";
}
