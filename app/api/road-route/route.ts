import {getAuthenticatedUser} from '@/app/supabase-auth-server';
import {inKarachi} from '@/lib/locations';
import {readRoadRoute,type RoadRoute} from '@/lib/road-route';
export const dynamic='force-dynamic';
const cache=new Map<string,{expires:number;route:RoadRoute}>();
let nextRequestAt=0;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request:Request){
 if(!await getAuthenticatedUser())return json({error:'Please sign in to request directions.'},401);
 const params=new URL(request.url).searchParams;
 const values=['fromLat','fromLng','toLat','toLng'].map(key=>params.has(key)&&params.get(key)!==''?Number(params.get(key)):NaN);
 const [a,b,c,d]=values;
 if(!inKarachi(a,b)||!inKarachi(c,d))return json({error:'Select confirmed endpoints inside Karachi.'},400);
 const key=values.map(v=>v.toFixed(5)).join(','),saved=cache.get(key);
 if(saved&&saved.expires>Date.now())return json({route:saved.route});
 if(Date.now()<nextRequestAt)return json({error:'Directions are busy. Wait a moment and try again.'},429);
 nextRequestAt=Date.now()+1100;
 try{
  const endpoint=process.env.ROAD_ROUTING_URL||'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
  const url=new URL(`${endpoint.replace(/\/$/,'')}/${b},${a};${d},${c}`);
  url.search=new URLSearchParams({overview:'full',geometries:'geojson',steps:'true',alternatives:'false'}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(12000),headers:{Accept:'application/json','User-Agent':'Humsafar-Karachi-Pilot/1.0 (https://github.com/AreebAshraf96/Humsafar)'}});
  if(!response.ok)throw new Error('Routing unavailable');
  const route=readRoadRoute(await response.json());
  if(cache.size>=128)cache.delete(cache.keys().next().value!);
  cache.set(key,{expires:Date.now()+15*60*1000,route});return json({route});
 }catch{return json({error:'Could not calculate a road route. Please try again later.'},503)}
}
