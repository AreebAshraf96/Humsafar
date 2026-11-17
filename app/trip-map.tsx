'use client';
import {useEffect,useState} from 'react';
import {parsePlace} from '@/lib/locations';
import type {RoadRoute} from '@/lib/road-route';
import {validSession} from '@/lib/supabase-auth';
import RideMap from './ride-map';

type Trip={id:string;origin_point?:string|null;destination_point?:string|null;lat?:number|null;lng?:number|null;sharing?:number;status:string;updated?:number|null};
export default function TripMap({ride}:{ride?:Trip}){
 const [result,setResult]=useState<{key:string;route:RoadRoute;calculated:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const origin=parsePlace(ride?.origin_point),destination=parsePlace(ride?.destination_point);
 const live=ride?.sharing===1&&ride.lat!=null&&ride.lng!=null;
 const from=live&&ride?{lat:ride.lat!,lng:ride.lng!}:origin;
 const target=ride?.status==='enroute'?origin:destination;
 // Results belong to an exact pair of endpoints; a moving driver invalidates
 // the old estimate instead of displaying it as a current ETA.
 const key=from&&target?`${ride?.id}:${from.lat},${from.lng}:${target.lat},${target.lng}`:'';
 const current=result?.key===key?result:null;
 useEffect(()=>{const timer=setTimeout(()=>setError(''),0);return()=>clearTimeout(timer)},[key]);
 async function directions(){
  if(!from||!target||busy)return;setBusy(true);setError('');
  try{const session=await validSession();if(!session)throw new Error('Please sign in again.');
   const params=new URLSearchParams({fromLat:String(from.lat),fromLng:String(from.lng),toLat:String(target.lat),toLng:String(target.lng)});
   const response=await fetch('/api/road-route?'+params,{headers:{Authorization:`Bearer ${session.access_token}`}});
   const data=await response.json() as {route:RoadRoute;error?:string};if(!response.ok)throw new Error(data.error||'Directions unavailable');
   setResult({key,route:data.route,calculated:Date.now()});
  }catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 return <div className="detailstack"><RideMap lat={from?.lat} lng={from?.lng} active={!!from} route={current?.route.coordinates}/><p className="muted">{live?'The marker is the latest reported GPS position.':'Confirm the meeting pin rather than relying on a suburb label.'}</p>{key&&<><button type="button" className="outline" onClick={directions} disabled={busy}>{busy?'Calculating…':current?'Refresh directions':'Show road route and turns'}</button><p className="muted">{ride?.status==='enroute'?'Directions to pickup.':'Directions to destination.'} Endpoint coordinates are sent to the routing provider when you request directions.</p></>}{error&&<p role="alert" className="banner error">{error}</p>}{current&&<><div className="banner"><strong>{(current.route.distance/1000).toFixed(1)} km · about {Math.max(1,Math.ceil(current.route.duration/60))} min</strong><p>Estimated arrival {new Date(current.calculated+current.route.duration*1000).toLocaleTimeString('en-PK',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Karachi'})} PKT</p><p>Calculated {new Date(current.calculated).toLocaleTimeString('en-PK',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Karachi'})} PKT. No live traffic. Suggested road route; not a record of the driver&apos;s journey.</p></div><details><summary>Turn instructions ({current.route.steps.length})</summary><ol>{current.route.steps.map((step,i)=><li key={i}>{step.instruction} · {Math.round(step.distance)} m</li>)}</ol></details><p className="muted">Routing: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noreferrer">OSRM / FOSSGIS</a> · © OpenStreetMap contributors</p></>}{ride&&!key&&<p className="muted">This ride has no confirmed route endpoints available. Only its reported position can be shown.</p>}</div>;
}
