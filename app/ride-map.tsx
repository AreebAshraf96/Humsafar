'use client';
import {useEffect,useRef,useState} from 'react';
import type {Map as LibreMap,Marker,GeoJSONSource} from 'maplibre-gl';
import {KARACHI} from '@/lib/locations';

export default function RideMap({lat,lng,active=false,onPick,route}:{lat?:number|null;lng?:number|null;active?:boolean;onPick?:(lat:number,lng:number)=>void;route?:[number,number][]}){
 const element=useRef<HTMLDivElement>(null),map=useRef<LibreMap|null>(null),marker=useRef<Marker|null>(null),[failed,setFailed]=useState(false),[ready,setReady]=useState(false);
 const pickRef=useRef(onPick);useEffect(()=>{pickRef.current=onPick},[onPick]);
 useEffect(()=>{
  let disposed=false;
  import('maplibre-gl').then(L=>{
   if(disposed||!element.current)return;
   // Serve the vendor worker unchanged: Vite's dev transforms inject the
   // window-only HMR client into this library's dynamic worker imports.
   L.setWorkerUrl('/maplibre-worker.mjs');
   const view=new L.Map({container:element.current,style:process.env.NEXT_PUBLIC_MAP_STYLE||'https://tiles.openfreemap.org/styles/liberty',center:[KARACHI.lng,KARACHI.lat],zoom:11});map.current=view;
   view.scrollZoom.disable();view.addControl(new L.NavigationControl(),'top-right');
   if(pickRef.current)view.setMaxBounds([[KARACHI.west,KARACHI.south],[KARACHI.east,KARACHI.north]]).setMinZoom(10);
   view.on('click',e=>pickRef.current?.(e.lngLat.lat,e.lngLat.lng));
   view.on('load',()=>{if(!disposed){setReady(true);setFailed(false)}});
   view.on('error',()=>{if(!disposed)setFailed(true)});
  }).catch(()=>{if(!disposed)setFailed(true)});
  return()=>{disposed=true;marker.current?.remove();marker.current=null;map.current?.remove();map.current=null};
 },[]);
 useEffect(()=>{
  const view=map.current;if(!view||!ready)return;
  if(!active||lat==null||lng==null){marker.current?.remove();marker.current=null;return}
  let disposed=false;
  import('maplibre-gl').then(L=>{if(disposed||map.current!==view)return;
   if(marker.current)marker.current.setLngLat([lng,lat]);else{marker.current=new L.Marker({color:'#087e82'}).setLngLat([lng,lat]).addTo(view);view.easeTo({center:[lng,lat],zoom:15,duration:500})}
  });return()=>{disposed=true};
 },[lat,lng,active,ready]);
 useEffect(()=>{
  const view=map.current;if(!view||!ready)return;
  const data={type:'Feature' as const,properties:{},geometry:{type:'LineString' as const,coordinates:route||[]}};
  const source=view.getSource('road-route') as GeoJSONSource|undefined;
  if(source)source.setData(data);else if(route?.length){view.addSource('road-route',{type:'geojson',data});view.addLayer({id:'road-route',type:'line',source:'road-route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#087e82','line-width':5,'line-opacity':0.8}})}
  if(route?.length){let west=180,south=90,east=-180,north=-90;for(const [x,y] of route){west=Math.min(west,x);east=Math.max(east,x);south=Math.min(south,y);north=Math.max(north,y)}view.fitBounds([[west,south],[east,north]],{padding:35,maxZoom:16,duration:500})}
 },[route,ready]);
 const location=active&&lat!=null&&lng!=null?`?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`:`#map=11/${KARACHI.lat}/${KARACHI.lng}`;
 return <div><div ref={element} className="mapframe" aria-label={onPick?'Click to choose a Karachi meeting point':active?'Selected location on the map':'Map of Karachi'}/>{active&&lat!=null&&lng!=null&&<p className="muted">Exact pin: {lat.toFixed(6)}, {lng.toFixed(6)}</p>}{failed&&<p className="muted">The map could not fully load. Your selected coordinates are preserved. Check your connection or open the map below.</p>}<a className="muted" style={{display:'inline-block',marginTop:8,textDecoration:'underline'}} href={'https://www.openstreetmap.org/'+location} target="_blank" rel="noreferrer">Open larger map / report a map error</a></div>;
}
