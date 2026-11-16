// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapPin, Pencil, Undo2, X, Check } from "lucide-react";
import { Button, inputClassName, selectClassName } from "../ui";
import { httpClient } from "../../lib/httpClient";
import { geometryError } from "../../lib/geometry";
type Position = [number, number];
type DrawType = "Point" | "LineString" | "Polygon";
function editablePoints(value: string): { type: DrawType; points: Position[] } | null {
  try { const g = JSON.parse(value); if (geometryError(g)) return null;
    if (g.type === "Point") return { type: g.type, points: [g.coordinates] };
    if (g.type === "LineString") return { type: g.type, points: g.coordinates };
    if (g.type === "Polygon" && g.coordinates.length === 1) return { type: g.type, points: g.coordinates[0].slice(0, -1) };
  } catch {} return null;
}
export function GeometryField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const node = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null);
  const [drawing, setDrawing] = useState(false), [type, setType] = useState<DrawType>("Point"), [points, setPoints] = useState<Position[]>([]), [error, setError] = useState(""), [tilesFailed, setTilesFailed] = useState(false);
  const drawRef = useRef({ drawing, type }); drawRef.current = { drawing, type };
  useEffect(() => {
    if (!node.current) return;
    const current = L.map(node.current, { scrollWheelZoom: false }).setView([16.06, 108.22], 6); map.current = current;
    const urls = new Map<HTMLImageElement, string>(); let disposed = false;
    class Tiles extends L.TileLayer {
      createTile(coords: L.Coords, done: L.DoneCallback) {
        const image = document.createElement("img"); image.alt = ""; image.setAttribute("role", "presentation");
        httpClient.get<Blob>(`/v1/capabilities/geo/tiles/${coords.z}/${coords.x}/${coords.y}.png`, { responseType: "blob" }).then(response => {
          if (disposed) return; const url = URL.createObjectURL(response.data); urls.set(image, url);
          image.onload = () => done(undefined, image); image.onerror = () => { setTilesFailed(true); done(new Error("Map tiles unavailable"), image); }; image.src = url;
        }).catch(() => { if (!disposed) setTilesFailed(true); done(new Error("Map tiles unavailable"), image); }); return image;
      }
    }
    new Tiles("", { maxZoom: 18, attribution: "Map data © VietMap", keepBuffer: 1 }).on("tileunload", event => { const image = (event as L.TileEvent).tile as HTMLImageElement, url = urls.get(image); if (url) URL.revokeObjectURL(url); urls.delete(image); }).addTo(current);
    current.on("click", (event: L.LeafletMouseEvent) => { if (!drawRef.current.drawing) return; const position: Position = [Number(event.latlng.lng.toFixed(6)), Number(event.latlng.lat.toFixed(6))]; if (Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) return;
      setPoints(old => drawRef.current.type === "Point" ? [position] : old.length < 5000 ? [...old, position] : old); setError(""); });
    const observer = new ResizeObserver(() => current.invalidateSize()); observer.observe(node.current);
    return () => { disposed = true; observer.disconnect(); current.remove(); map.current = null; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, []);
  useEffect(() => {
    const current = map.current; if (!current) return;
    let layer: L.Layer | undefined;
    if (!drawing && value) { try { const g = JSON.parse(value); if (!geometryError(g)) { const geo = L.geoJSON(g, { style: { color: "#0d9488", weight: 3 }, pointToLayer: (_, at) => L.circleMarker(at, { radius: 7, color: "#0d9488" }) }); layer = geo; geo.addTo(current); const bounds = geo.getBounds(); if (bounds.isValid()) current.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 }); } } catch {} }
    if (drawing && points.length) { const group = L.featureGroup(); const latlngs: L.LatLngTuple[] = points.map(([lng, lat]) => [lat, lng]); if (type !== "Point" && points.length > 1) (type === "Polygon" && points.length > 2 ? L.polygon(latlngs, { color: "#6366f1" }) : L.polyline(latlngs, { color: "#6366f1" })).addTo(group);
      latlngs.forEach((at, i) => L.marker(at, { draggable: true, icon: L.divIcon({ className: "", html: '<span style="display:block;width:14px;height:14px;background:#6366f1;border:2px solid white;border-radius:50%;box-shadow:0 1px 4px #64748b"></span>', iconSize: [14, 14], iconAnchor: [7, 7] }) }).on("dragend", event => { const at = (event.target as L.Marker).getLatLng(); if (Math.abs(at.lng) <= 180 && Math.abs(at.lat) <= 90) setPoints(old => old.map((p, n) => n === i ? [Number(at.lng.toFixed(6)), Number(at.lat.toFixed(6))] : p)); }).addTo(group));
      group.addTo(current); layer = group;
    }
    return () => { layer?.remove(); };
  }, [value, drawing, points, type]);
  const begin = (edit: boolean) => { const existing = edit ? editablePoints(value) : null; setType(existing?.type || "Point"); setPoints(existing?.points || []); setDrawing(true); setError(""); };
  const apply = () => { const geometry = { type, coordinates: type === "Point" ? points[0] : type === "Polygon" ? [[...points, points[0]]] : points }; const issue = geometryError(geometry); if (issue) { setError(issue); return; } onChange(JSON.stringify(geometry, null, 2)); setDrawing(false); };
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">{drawing ? <><select aria-label={`${label} drawing type`} className={selectClassName + " max-w-40"} value={type} onChange={e => { setType(e.target.value as DrawType); setPoints([]); setError(""); }}><option value="Point">Point</option><option value="LineString">Line</option><option value="Polygon">Polygon</option></select><Button type="button" onClick={() => setPoints(old => old.slice(0, -1))} disabled={!points.length}><Undo2 size={13} />Undo point</Button><Button type="button" onClick={apply}><Check size={13} />Use geometry</Button><Button type="button" variant="ghost" onClick={() => { setDrawing(false); setError(""); }}><X size={13} />Cancel drawing</Button></> : <><Button type="button" onClick={() => begin(false)}><MapPin size={13} />Draw geometry</Button><Button type="button" disabled={!editablePoints(value)} onClick={() => begin(true)}><Pencil size={13} />Edit vertices</Button><Button type="button" variant="ghost" disabled={!value} onClick={() => onChange("")}>Clear geometry</Button></>}</div>
    <div ref={node} aria-label={`${label} drawing map`} className="relative isolate z-0 h-72 rounded-lg bg-slate-100" />
    {drawing ? <><p className="text-xs text-dx-muted">Click the map to add {type === "Point" ? "a point" : "vertices"}. Drag vertices to adjust. Use geometry applies the shape to this field; submit the form to save it.</p><div className="max-h-40 space-y-2 overflow-auto">{points.map(([lng, lat], index) => <div key={index} className="grid grid-cols-[20px_1fr_1fr] items-center gap-2"><span className="text-xs text-dx-muted">{index + 1}</span>{[["Longitude", lng, 0], ["Latitude", lat, 1]].map(([name, coordinate, axis]) => <input key={String(name)} type="number" step="any" aria-label={`${name} of vertex ${index + 1}`} className={inputClassName} value={coordinate} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) setPoints(old => old.map((point, i) => i === index ? point.map((v, a) => a === axis ? n : v) as Position : point)); }} />)}</div>)}</div></> : <p className="text-xs text-dx-muted">Point, line and polygon drawing. Use JSON for multiple geometries or polygons with holes.</p>}
    {tilesFailed && <p role="status" className="text-xs text-amber-700">Basemap unavailable. Coordinates and drawing remain usable.</p>}{error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
  </div>;
}
