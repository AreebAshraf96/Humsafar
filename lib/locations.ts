/** A pilot service rectangle, not an administrative boundary or coverage guarantee. */
export const KARACHI = {south:24.70,west:66.75,north:25.25,east:67.60,lat:24.8607,lng:67.0011};
export type Place = {id:string;label:string;address:string;lat:number;lng:number;source:'photon'|'pin'};

export function inKarachi(lat:unknown,lng:unknown):boolean {
 return typeof lat==='number'&&typeof lng==='number'&&Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=KARACHI.south&&lat<=KARACHI.north&&lng>=KARACHI.west&&lng<=KARACHI.east;
}
export function validatePlace(value:unknown):Place {
 if(!value||typeof value!=='object')throw new Error('Select and confirm a Karachi location from the dropdown or map.');
 const p=value as Record<string,unknown>;
 if(!inKarachi(p.lat,p.lng))throw new Error('Choose a location inside the Karachi pilot area.');
 for(const [key,max] of [['id',140],['label',160],['address',250]] as const){if(typeof p[key]!=='string'||(p[key] as string).length>max||(key!=='address'&&!(p[key] as string).trim()))throw new Error('The selected location is invalid. Please choose it again.');}
 if(p.source!=='photon'&&p.source!=='pin')throw new Error('Invalid location source.');
 return {id:(p.id as string).trim(),label:(p.label as string).trim(),address:(p.address as string).trim(),lat:p.lat as number,lng:p.lng as number,source:p.source};
}
export function parsePlace(value:unknown):Place|null {try{return validatePlace(typeof value==='string'?JSON.parse(value):value)}catch{return null}}
export function photonPlaces(data:unknown):Place[] {
 const features=(data as {features?:unknown[]})?.features;if(!Array.isArray(features))return [];
 const seen=new Set<string>();const places:Place[]=[];
 for(const feature of features){
  if(!feature||typeof feature!=='object')continue;
  const f=feature as {properties?:Record<string,unknown>;geometry?:{type?:string;coordinates?:unknown[]}};
  const p=f.properties,c=f.geometry?.coordinates;if(!p||f.geometry?.type!=='Point'||!Array.isArray(c)||!inKarachi(c[1],c[0])||String(p.countrycode).toUpperCase()!=='PK')continue;
  const name=typeof p.name==='string'?p.name:[p.housenumber,p.street].filter(v=>typeof v==='string').join(' ');if(!name.trim())continue;
  const label=name.slice(0,160),address=[...new Set([p.housenumber,p.street,p.district,p.city,'Karachi'].filter(v=>typeof v==='string'&&v!==name))].join(', ').slice(0,250);
  const id=`osm:${p.osm_type}:${p.osm_id}`;if(seen.has(id))continue;seen.add(id);
  places.push({id,label,address,lat:c[1] as number,lng:c[0] as number,source:'photon'});
 }
 return places.slice(0,6);
}
export function distanceKm(a:Pick<Place,'lat'|'lng'>,b:Pick<Place,'lat'|'lng'>):number {
 const radians=(n:number)=>n*Math.PI/180;const dLat=radians(b.lat-a.lat),dLng=radians(b.lng-a.lng);
 const h=Math.sin(dLat/2)**2+Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(dLng/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
export function endpointMatches(saved:unknown,requested:Place|null):boolean {if(!requested)return true;const p=parsePlace(saved);return !!p&&distanceKm(p,requested)<=1;}
