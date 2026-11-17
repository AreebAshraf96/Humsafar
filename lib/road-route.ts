export type Coordinate={lat:number;lng:number};
export type RoadRoute={coordinates:[number,number][];distance:number;duration:number;steps:{instruction:string;distance:number;duration:number}[]};
export function readRoadRoute(value:unknown):RoadRoute {
 const data=value as {code?:string;routes?:{distance:number;duration:number;geometry?:{coordinates?:[number,number][]};legs?:{steps?:{name?:string;distance:number;duration:number;maneuver?:{type?:string;modifier?:string;exit?:number}}[]}[]}[]};
 const route=data?.routes?.[0],coordinates=route?.geometry?.coordinates;
 if(data?.code!=='Ok'||!route||!Array.isArray(coordinates)||coordinates.length<2||coordinates.length>50000||!Number.isFinite(route.duration)||route.duration<0||!Number.isFinite(route.distance)||route.distance<0)throw new Error('No road route available.');
 if(coordinates.some(p=>!Array.isArray(p)||p.length!==2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>180||Math.abs(p[1])>90))throw new Error('Invalid road geometry.');
 const steps=(route.legs||[]).flatMap(leg=>(leg.steps||[]).map(step=>{
  const m=step.maneuver||{},type=m.type||'continue';
  const action=type==='depart'?'Start':type==='arrive'?'Arrive at destination':type==='roundabout'||type==='rotary'?`Take roundabout${m.exit?` exit ${m.exit}`:''}`:`${(type.charAt(0).toUpperCase()+type.slice(1))}${m.modifier?' '+m.modifier:''}`;
  return {instruction:(action+(step.name?' · '+step.name:'')).slice(0,250),distance:step.distance,duration:step.duration};
 }));
 if(steps.length>2000||steps.some(s=>!Number.isFinite(s.distance)||s.distance<0||!Number.isFinite(s.duration)||s.duration<0))throw new Error('Invalid road directions.');
 return {coordinates,distance:route.distance,duration:route.duration,steps};
}
