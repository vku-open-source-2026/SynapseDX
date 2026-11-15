// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useContext, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, Layers, MapPin, Maximize2 } from 'lucide-react';
import { httpClient } from '../../lib/httpClient';
import { safeCellText, type RuntimeWidget, type WidgetData } from '../../lib/workspaces';
import { RecordSelection } from './RecordSelection';

import { recordGeometry } from '../../lib/mapGeometry';

export function MapWidget({widget,data,preview}:{widget:RuntimeWidget;data?:WidgetData;preview?:boolean}) {
  const node = useRef<HTMLDivElement>(null), mapRef = useRef<L.Map | null>(null);
  const {select} = useContext(RecordSelection);
  const [tilesFailed,setTilesFailed] = useState(false), [showLayer,setShowLayer] = useState(true);
  const rows = data?.rows ?? [];
  const located = rows.map(row=>({row,geometry:recordGeometry(row)})).filter(item=>item.geometry);
  const boundsRef = useRef<L.LatLngBounds | null>(null);
  useEffect(()=>{
    if (!node.current) return;
    const map=L.map(node.current,{scrollWheelZoom:false,zoomControl:false}).setView([16.06,108.22],6);
    mapRef.current=map;L.control.zoom({position:'bottomright'}).addTo(map);
    const tileUrls=new Map<HTMLImageElement,string>();
    class Tiles extends L.TileLayer {
      createTile(coords:L.Coords,done:L.DoneCallback) {
        const tile=document.createElement('img'); tile.alt=''; tile.setAttribute('role','presentation');
        // Tokens stay in the Authorization header; the refresh-aware HTTP
        // client rotates sessions before loading protected provider tiles.
        httpClient.get<Blob>(`/v1/capabilities/geo/tiles/${coords.z}/${coords.x}/${coords.y}.png`,{responseType:'blob'}).then(response=>{
          if(!mapRef.current)return;
          const url=URL.createObjectURL(response.data);tileUrls.set(tile,url);
          tile.onload=()=>done(undefined,tile);tile.onerror=()=>{setTilesFailed(true);done(new Error('Map tile failed'),tile);};tile.src=url;
        }).catch(()=>{setTilesFailed(true);done(new Error('Map tiles unavailable'),tile);});
        return tile;
      }
    }
    if(!preview) new Tiles('',{maxZoom:18,attribution:'Map data © VietMap',keepBuffer:1}).on('tileunload',(event:L.TileEvent)=>{const tile=(event as L.TileEvent).tile as HTMLImageElement;const url=tileUrls.get(tile);if(url)URL.revokeObjectURL(url);tileUrls.delete(tile);}).addTo(map);
    const observer=new ResizeObserver(()=>map.invalidateSize());observer.observe(node.current);
    return ()=>{observer.disconnect();mapRef.current=null;map.remove();tileUrls.forEach(url=>URL.revokeObjectURL(url));};
  },[preview]);
  useEffect(()=>{
    const map=mapRef.current;if(!map)return;
    const group=L.featureGroup();
    for(const {row,geometry} of located){
      try{
        const color=['critical','high','active','in_progress'].includes(String(row.severity??row.status))?'#e46d47':'#13a89e';
        const layer=L.geoJSON(geometry as GeoJSON.Geometry,{style:{color,weight:2,fillOpacity:.12},pointToLayer:(_,latlng)=>L.circleMarker(latlng,{radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:1})});
        const popup=document.createElement('div');const title=document.createElement('strong');title.textContent=safeCellText(row.name??row.title??row.id);popup.append(title);
        const info=document.createElement('p');info.textContent=[row.status,row.address,row.district].filter(Boolean).join(' · ');popup.append(info);
        const open=document.createElement('button');open.textContent='View details';open.className='mt-2 font-semibold text-teal-700';open.onclick=()=>select(widget.resource||'',row);popup.append(open);
        layer.bindPopup(popup);layer.on('click',()=>select(widget.resource||'',row));group.addLayer(layer);
      }catch{/* Malformed geometry is excluded without breaking other features. */}
    }
    const bounds=group.getBounds();boundsRef.current=bounds.isValid()?bounds:null;
    if(showLayer)group.addTo(map);if(bounds.isValid())map.fitBounds(bounds,{padding:[35,35],maxZoom:14});
    return()=>{group.remove();};
  },[data,showLayer,select,widget.resource]);
  return <div className="space-y-3">
    <div className="relative isolate overflow-hidden rounded-xl border border-dx-line bg-[#e9eff0]">
      <div ref={node} className="z-0 h-[420px] w-full" aria-label={`${widget.title} interactive map`} />
      <div className="absolute left-3 top-3 z-[401] flex gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        <button className="map-control" type="button" aria-label="Fit all locations" onClick={()=>{if(boundsRef.current)mapRef.current?.fitBounds(boundsRef.current,{padding:[35,35],maxZoom:14});}}><Crosshair size={16}/></button>
        <button className="map-control" type="button" aria-label="Toggle map records" aria-pressed={showLayer} onClick={()=>setShowLayer(!showLayer)}><Layers size={16}/></button>
        <button className="map-control" type="button" aria-label="Expand map" onClick={()=>{void node.current?.parentElement?.requestFullscreen?.();}}><Maximize2 size={16}/></button>
      </div>
      <div className="absolute bottom-4 left-3 z-[401] rounded-lg bg-white/95 px-3 py-2 text-[11px] font-medium text-slate-600 shadow-sm"><span className="mr-2 inline-block h-2 w-2 rounded-full bg-teal-500"/>{located.length} located · {rows.length-located.length} without location{preview?' · Layout preview':''}</div>
    </div>
    {tilesFailed?<p role="status" className="text-xs text-amber-700">The basemap is unavailable. Your record locations are still displayed.</p>:null}
    {!preview&&located.length===0?<p className="flex items-center gap-2 text-xs text-dx-muted"><MapPin size={14}/>Records appear here when valid coordinates or GeoJSON are available.</p>:null}
  </div>;
}
