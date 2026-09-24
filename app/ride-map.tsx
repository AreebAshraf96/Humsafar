'use client';
import {useEffect,useRef,useState} from 'react';
import type {Map as LeafletMap,CircleMarker} from 'leaflet';
import {KARACHI} from '@/lib/locations';

export default function RideMap({lat,lng,active=false,onPick}:{lat?:number|null;lng?:number|null;active?:boolean;onPick?:(lat:number,lng:number)=>void}){
 const element=useRef<HTMLDivElement>(null),map=useRef<LeafletMap|null>(null),marker=useRef<CircleMarker|null>(null),[failed,setFailed]=useState(false),[ready,setReady]=useState(false);
 const pickRef=useRef(onPick);pickRef.current=onPick;
 useEffect(()=>{
  let disposed=false;
  import('leaflet').then(L=>{
   if(disposed||!element.current)return;
   const view=L.map(element.current,{scrollWheelZoom:false}).setView([KARACHI.lat,KARACHI.lng],11);map.current=view;
   if(pickRef.current)view.setMaxBounds([[KARACHI.south,KARACHI.west],[KARACHI.north,KARACHI.east]]).setMinZoom(10);
   L.tileLayer(process.env.NEXT_PUBLIC_MAP_TILES||'https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).on('tileerror',()=>setFailed(true)).addTo(view);
   view.on('click',e=>pickRef.current?.(e.latlng.lat,e.latlng.lng));setReady(true);
  }).catch(()=>setFailed(true));
  return()=>{disposed=true;map.current?.remove();map.current=null;marker.current=null};
 },[]);
 useEffect(()=>{
  const view=map.current;if(!view||!ready)return;
  if(!active||lat==null||lng==null){marker.current?.remove();marker.current=null;return}
  import('leaflet').then(L=>{if(map.current!==view)return;if(marker.current)marker.current.setLatLng([lat,lng]);else marker.current=L.circleMarker([lat,lng],{radius:10,color:'#ffffff',weight:3,fillColor:'#087e82',fillOpacity:1}).addTo(view);view.setView([lat,lng],Math.max(view.getZoom(),15))});
 },[lat,lng,active,ready]);
 const location=active&&lat!=null&&lng!=null?`?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`:`#map=11/${KARACHI.lat}/${KARACHI.lng}`;
 return <div><div ref={element} className="mapframe" aria-label={onPick?'Click to choose a Karachi meeting point':active?'Selected location on the map':'Map of Karachi'}/>{failed&&<p className="muted">Some map tiles could not load. Check your connection or open the map below.</p>}<a className="muted" style={{display:'inline-block',marginTop:8,textDecoration:'underline'}} href={'https://www.openstreetmap.org/'+location} target="_blank" rel="noreferrer">Open larger map</a></div>;
}
