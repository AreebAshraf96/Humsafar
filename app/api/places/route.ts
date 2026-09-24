import {KARACHI,photonPlaces,type Place} from '@/lib/locations';
export const dynamic='force-dynamic';
const cache=new Map<string,{expires:number;places:Place[]}>();
let nextRequestAt=0;
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request:Request){
 const q=new URL(request.url).searchParams.get('q')?.trim()||'';
 if(q.length<3||q.length>120)return response({error:'Type between 3 and 120 characters.'},400);
 const key=q.toLocaleLowerCase(),saved=cache.get(key);if(saved&&saved.expires>Date.now())return response({places:saved.places});
 // Small-pilot protection; a production deployment needs a shared quota or its own provider.
 if(Date.now()<nextRequestAt)return response({error:'Search is busy. Please pause a moment and try again.'},429);
 nextRequestAt=Date.now()+1000;
 try{
  const endpoint=process.env.PHOTON_SEARCH_URL||'https://photon.komoot.io/api/';
  const url=new URL(endpoint);url.search=new URLSearchParams({q,bbox:`${KARACHI.west},${KARACHI.south},${KARACHI.east},${KARACHI.north}`,countrycode:'PK',lat:String(KARACHI.lat),lon:String(KARACHI.lng),limit:'8',lang:'en'}).toString();
  const r=await fetch(url,{headers:{'Accept':'application/json','User-Agent':'Humsafar-Karachi-Pilot/1.0 (https://github.com/AreebAshraf96/Humsafar)'},signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error('Provider unavailable');
  const places=photonPlaces(await r.json());if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(key,{expires:Date.now()+15*60*1000,places});
  return response({places});
 }catch{return response({error:'Place search is temporarily unavailable. You can still choose a map pin.'},503)}
}
