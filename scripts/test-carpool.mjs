import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const sqlite=new DatabaseSync(':memory:');
for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
function prepared(sql,params=[]){return {bind(...p){return prepared(sql,p)},async all(){return {results:sqlite.prepare(sql).all(...params)}},async first(){return sqlite.prepare(sql).get(...params)||null},async run(){const r=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(r.changes)}}}}}
const db={prepare:prepared,async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}};
let identity=null;
globalThis.__carpoolTest={db:()=>db,stmt:(sql,...p)=>prepared(sql,p),all:async(sql,...p)=>(await prepared(sql,p).all()).results,one:async(sql,...p)=>prepared(sql,p).first(),getChatGPTUser:async()=>identity};
function moduleUrl(source){return 'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64')}
const domain=await import(moduleUrl(readFileSync(new URL('../lib/domain.ts',import.meta.url),'utf8')));
const locations=await import(moduleUrl(readFileSync(new URL('../lib/locations.ts',import.meta.url),'utf8')));
globalThis.__carpoolTest={...globalThis.__carpoolTest,...domain,...locations};
let src=readFileSync(new URL('../app/api/carpool/route.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
src='const {getChatGPTUser,all,one,stmt,db,canTransition,departureDates,pakistanToday,routeMatches,validatePlace,endpointMatches,distanceKm}=globalThis.__carpoolTest;\n'+src;
const {GET,POST}=await import(moduleUrl(src));
let checks=0;function check(value,message){assert.ok(value,message);checks++}
async function post(action,payload={},status=200){const r=await POST(new Request('https://test.local/api/carpool',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://test.local'},body:JSON.stringify({action,...payload})}));const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));checks++;return data}
async function get(query,status=200){const r=await GET(new Request('https://test.local/api/carpool?'+query));const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));checks++;return data}
function user(id){identity={userId:id,email:id+'@example.test',fullName:id}}
await post('profile',{name:'No session'},401);
user('driver');await post('profile',{name:'Test Driver',gender:'Man',phone:'+923001234567'});
const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
const originPoint={id:'test:clifton',label:'Dolmen Mall Clifton',address:'Clifton, Karachi',lat:24.8021172,lng:67.0302623,source:'pin'};
const destinationPoint={id:'test:ubl',label:'UBL City Building',address:'I. I. Chundrigar Road, Karachi',lat:24.8492715,lng:67.0013189,source:'pin'};
const listing={originPoint,destinationPoint,stops:'Saddar',date:tomorrow,time:'23:30',seats:1,car:'White Toyota Corolla',plate:'TEST-123',fare:null,notes:'Test only',pickup:'Public landmark',dropoff:'Central stop',days:[]};
await post('create',listing);
let ride=(await get('action=rides&date='+tomorrow)).rides[0];check(ride.id,'ride created');check(ride.plate===undefined&&ride.phone===undefined&&ride.lat===undefined,'private fields excluded from listings');
check((await get('action=rides&date='+tomorrow+'&from=Saddar&to=UBL')).rides.length===1,'forward intermediate text match');
check((await get('action=rides&date='+tomorrow+'&from=UBL&to=Saddar')).rides.length===0,'reverse route excluded');
const spatialQuery=(from,to)=>'action=rides&'+new URLSearchParams({date:tomorrow,fromPoint:JSON.stringify(from),toPoint:JSON.stringify(to)});
check((await get(spatialQuery(originPoint,destinationPoint))).rides.length===1,'confirmed locations match');
check((await get(spatialQuery({...originPoint,label:'Different spelling',lat:originPoint.lat+.002},destinationPoint))).rides.length===1,'nearby coordinates match without identical spelling');
check((await get(spatialQuery({...originPoint,lat:24.94},destinationPoint))).rides.length===0,'distant endpoint excluded');
check((await get(spatialQuery(destinationPoint,originPoint))).rides.length===0,'reversed endpoints excluded');
await get('action=rides&fromPoint=broken-json',400);
await post('create',{...listing,originPoint:{...originPoint,lat:31.5,lng:74.3}},400);
await post('create',{...listing,originPoint:null},400);
await post('create',{...listing,destinationPoint:originPoint},400);
check(JSON.parse(ride.origin_point).lat===originPoint.lat,'coordinates persist');
await post('request',{id:ride.id,message:'Own ride'},400);
await post('seats',{id:ride.id,seats:0},400);await post('seats',{id:ride.id,seats:2});await post('seats',{id:ride.id,seats:1});
user('passenger1');await post('profile',{name:'Passenger One',gender:'Woman',phone:''});await post('request',{id:ride.id,message:'Can we agree Rs 1500?'});await post('request',{id:ride.id,message:'duplicate'},400);
await post('seats',{id:ride.id,seats:8},403);
const pending=(await get('action=detail&id='+ride.id));check(pending.ride.plate===undefined,'pending passenger cannot see plate');
await post('status',{id:ride.id,status:'enroute'},403);await post('location',{id:ride.id,lat:1,lng:1,accuracy:2},403);
user('passenger2');await post('profile',{name:'Passenger Two',gender:'Not specified',phone:''});await post('request',{id:ride.id,message:'Second request'});
user('driver');let detail=await get('action=detail&id='+ride.id);const first=detail.requests.find(b=>b.name==='Passenger One');const second=detail.requests.find(b=>b.name==='Passenger Two');
await post('approve',{id:ride.id,bookingId:first.id,reply:'Rs 1500 agreed'});await post('approve',{id:ride.id,bookingId:second.id},400);check((await get('action=detail&id='+ride.id)).ride.occupied===1,'seat cannot overbook');
await post('status',{id:ride.id,status:'started'},400);await post('status',{id:ride.id,status:'enroute'});await post('location',{id:ride.id,lat:31.5,lng:74.3,accuracy:10});
user('passenger2');detail=await get('action=detail&id='+ride.id);check(detail.ride.lat===undefined,'unapproved cannot track');
user('passenger1');detail=await get('action=detail&id='+ride.id);check(detail.ride.lat===31.5&&detail.ride.plate==='TEST-123','approved can see pickup location and plate');await post('share',{id:ride.id},400);
await post('cancelBooking',{id:ride.id});user('driver');await post('approve',{id:ride.id,bookingId:second.id});await post('status',{id:ride.id,status:'arrived'});await post('status',{id:ride.id,status:'started'});
user('passenger2');const share=await post('share',{id:ride.id});identity=null;let shared=await post('track',{token:share.token});check(shared.ride.lat===31.5&&!shared.ride.phone&&!shared.passengers,'share minimum data only');
user('passenger1');await post('share',{id:ride.id},403);user('passenger2');await post('cancelBooking',{id:ride.id},400);await post('revokeShare',{id:ride.id});identity=null;await post('track',{token:share.token},404);
user('passenger2');const share2=await post('share',{id:ride.id});sqlite.prepare('UPDATE shares SET expires=0').run();identity=null;await post('track',{token:share2.token},404);
user('passenger2');const share3=await post('share',{id:ride.id});user('driver');await post('status',{id:ride.id,status:'ended'});identity=null;await post('track',{token:share3.token},404);check(sqlite.prepare('SELECT lat,sharing FROM rides').get().lat===null,'end clears coordinates');
user('driver');await post('create',{...listing,days:[1,3,5]});check(sqlite.prepare('SELECT COUNT(*) AS n FROM rides').get().n===13,'recurring departures have independent records');
await post('seats',{id:ride.id,seats:3},400);
check(domain.departureDates('2026-10-01',[1]).length===4,'four week repeat');assert.throws(()=>domain.departureDates('2026-02-30',[]));checks++;
const csrf=await POST(new Request('https://test.local/api/carpool',{method:'POST',headers:{Origin:'https://other.example'},body:'{}'}));check(csrf.status===403,'cross origin mutations rejected');
console.log(`${checks} checks passed: authentication, route direction, recurrence, approval capacity, location access, cancellation, expiry, revocation, trip ending and cross-origin protection.`);
sqlite.close();delete globalThis.__carpoolTest;
