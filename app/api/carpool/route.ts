import {getChatGPTUser} from '../../chatgpt-auth';
import {all,one,stmt,db} from '../../../lib/store';
import {canTransition,departureDates,pakistanToday,routeMatches} from '../../../lib/domain';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'same-origin'}});
const fail=(message:string,status=400)=>json({error:message},status);
function str(v:unknown,max=160,required=true){if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw new Error('Please complete all required fields with valid values.');return v.trim();}
function num(v:unknown,min:number,max:number){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error('A numeric value is out of range.');return v;}
async function hash(token:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
const base=`SELECT r.id,r.driver,r.origin,r.destination,r.stops,r.date,r.time,r.seats,r.car,r.fare,r.notes,r.pickup,r.dropoff,r.status,r.version,p.name AS driverName,p.gender AS driverGender,(SELECT COUNT(*) FROM bookings b WHERE b.ride=r.id AND b.status='approved') AS occupied FROM rides r JOIN profiles p ON p.id=r.driver`;
async function manifest(id:string){return all(`SELECT p.name,p.gender FROM bookings b JOIN profiles p ON p.id=b.passenger WHERE b.ride=? AND b.status='approved' ORDER BY b.created`,id);}
export async function GET(request:Request){try{
 const u=new URL(request.url),action=u.searchParams.get('action')||'rides';const user=await getChatGPTUser();
 if(action==='me')return json({user:user?{id:user.userId,name:user.fullName??'Your profile'}:null,profile:user?await one('SELECT name,gender,phone FROM profiles WHERE id=?',user.userId):null});
 if(action==='rides'){
  const date=u.searchParams.get('date')||pakistanToday();const from=(u.searchParams.get('from')||'').slice(0,160),to=(u.searchParams.get('to')||'').slice(0,160);
  let rides=await all(base+` WHERE r.date=? AND r.status='scheduled' AND datetime(r.date || 'T' || r.time || ':00','-5 hours') > datetime('now') ORDER BY r.time LIMIT 200`,date);
  rides=rides.filter(r=>routeMatches(r.origin,r.destination,r.stops,from,to)&&r.occupied<r.seats);
  return json({rides:await Promise.all(rides.map(async r=>({...r,passengers:await manifest(r.id)})))});
 }
 if(!user)return fail('Sign in to continue.',401);
 if(action==='trips'){
  const rides=await all(base+` WHERE r.driver=? OR r.id IN (SELECT ride FROM bookings WHERE passenger=?) ORDER BY r.date DESC,r.time DESC LIMIT 100`,user.userId,user.userId);
  return json({rides:await Promise.all(rides.map(async r=>({...r,booking:await one('SELECT id,status,message,reply FROM bookings WHERE ride=? AND passenger=?',r.id,user.userId),passengers:await manifest(r.id)})))});
 }
 if(action==='detail'){
  const id=u.searchParams.get('id')||'';const ride=await one(base+' WHERE r.id=?',id);if(!ride)return fail('Ride not found.',404);
  const booking=await one('SELECT id,status,message,reply FROM bookings WHERE ride=? AND passenger=?',id,user.userId);const own=ride.driver===user.userId;const approved=booking?.status==='approved';
  const privateData=(own||approved)?await one('SELECT r.plate,r.lat,r.lng,r.accuracy,r.updated,r.sharing,p.phone FROM rides r JOIN profiles p ON p.id=r.driver WHERE r.id=?',id):null;
  const requests=own?await all(`SELECT b.id,b.status,b.message,b.reply,p.name,p.gender,p.phone FROM bookings b JOIN profiles p ON p.id=b.passenger WHERE b.ride=? AND b.status IN ('pending','approved') ORDER BY b.created`,id):[];
  return json({ride:{...ride,...privateData},booking,passengers:await manifest(id),requests,own});
 }
 return fail('Unknown request.',404);
 }catch(e){console.error('Read failed',e);return fail('Unable to load saved rides. Please try again.',503);}}
export async function POST(request:Request){
 try{
 const origin=request.headers.get('origin');if(request.headers.get('sec-fetch-site')==='cross-site'||(origin&&new URL(origin).host!==new URL(request.url).host))return fail('Please use this website to submit changes.',403);
 if(Number(request.headers.get('content-length')||0)>16000)return fail('Request too large.',413);
 const raw=await request.text();if(raw.length>16000)return fail('Request too large.',413);const input=JSON.parse(raw);const action=input.action;
 if(action==='track'){
  const token=str(input.token,128);const share=await one(`SELECT s.ride,s.owner FROM shares s JOIN rides r ON r.id=s.ride WHERE s.token=? AND s.expires>? AND r.status='started' AND (r.driver=s.owner OR EXISTS (SELECT 1 FROM bookings b WHERE b.ride=r.id AND b.passenger=s.owner AND b.status='approved'))`,await hash(token),Date.now());
  if(!share)return fail('This trip link has expired or been stopped.',404);
  const ride=await one(`SELECT r.origin,r.destination,r.date,r.time,r.car,r.plate,r.status,r.lat,r.lng,r.accuracy,r.updated,r.sharing,p.name AS driverName FROM rides r JOIN profiles p ON p.id=r.driver WHERE r.id=?`,share.ride);return json({ride});
 }
 const user=await getChatGPTUser();if(!user)return fail('Sign in to continue.',401);const uid=user.userId;
 if(action==='profile'){
  const name=str(input.name,60);const gender=str(input.gender,30);if(!['Woman','Man','Non-binary','Not specified'].includes(gender))return fail('Choose a listed gender option.');const phone=str(input.phone,30,false);if(phone&&!/^\+92\d{10}$/.test(phone))return fail('Use a Pakistan number such as +923001234567.');
  await db().batch([stmt('INSERT INTO profiles (id,name,gender,phone) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,gender=excluded.gender,phone=excluded.phone',uid,name,gender,phone),stmt(`UPDATE rides SET version=version+1 WHERE status IN ('scheduled','enroute','arrived','started') AND (driver=? OR id IN (SELECT ride FROM bookings WHERE passenger=? AND status='approved'))`,uid,uid)]);return json({ok:true});
 }
 const profile=await one('SELECT id FROM profiles WHERE id=?',uid);if(!profile)return fail('Save your profile first.',409);
 if(action==='create'){
  const start=str(input.date,10);if(start<pakistanToday()||start>new Date(Date.now()+180*86400000).toISOString().slice(0,10))return fail('Choose a date within the next six months.');
  const days=input.days??[];if(!Array.isArray(days)||days.some(d=>!Number.isInteger(d)||d<0||d>6))return fail('Invalid repeat days.');const dates=departureDates(start,days);
  const origin=str(input.origin),destination=str(input.destination);if(origin.toLowerCase()===destination.toLowerCase())return fail('Choose different departure and destination locations.');
  const stops=str(input.stops??'',600,false),time=str(input.time,5);if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return fail('Choose a valid departure time.');
  const seats=num(input.seats,1,8);if(!Number.isInteger(seats))return fail('Seats must be a whole number.');const fare=input.fare===null?null:num(input.fare,0,100000);if(fare!==null&&!Number.isInteger(fare))return fail('Enter the fare in whole rupees.');
  const car=str(input.car,100),plate=str(input.plate,30),notes=str(input.notes??'',600,false),pickup=str(input.pickup,250),dropoff=str(input.dropoff,250);
  const futureDates=dates.filter(d=>Date.parse(d+'T'+time+':00+05:00')>Date.now());if(!futureDates.length)return fail('Departure must be in the future.');
  const count=await one('SELECT COUNT(*) AS n FROM rides WHERE driver=? AND date>=?',uid,pakistanToday());if(Number(count?.n)>100)return fail('You already have many upcoming rides. Please manage those first.');
  await db().batch(futureDates.map(date=>stmt('INSERT INTO rides (id,driver,origin,destination,stops,date,time,seats,car,plate,fare,notes,pickup,dropoff) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',crypto.randomUUID(),uid,origin,destination,stops,date,time,seats,car,plate,fare,notes,pickup,dropoff)));return json({ok:true,count:futureDates.length});
 }
 const id=str(input.id,64),ride=await one('SELECT * FROM rides WHERE id=?',id);if(!ride)return fail('Ride not found.',404);
 const own=ride.driver===uid;const booking=await one('SELECT * FROM bookings WHERE ride=? AND passenger=?',id,uid);
 if(action==='seats'){
  if(!own)return fail('Only the driver can update seats.',403);const seats=num(input.seats,1,8);if(!Number.isInteger(seats))return fail('Seats must be a whole number.');
  const result=await stmt(`UPDATE rides SET seats=?,version=version+1 WHERE id=? AND status IN ('scheduled','enroute','arrived') AND ? >= (SELECT COUNT(*) FROM bookings WHERE ride=? AND status='approved')`,seats,id,seats,id).run();
  if(!result.meta.changes)return fail('Seat capacity cannot be below approved bookings or changed after the trip starts.');return json({ok:true});
 }
 if(action==='request'){
  if(own)return fail('You cannot request a seat on your own ride.');const message=str(input.message,600);if(ride.status!=='scheduled')return fail('This ride is no longer accepting requests.');
  const result=await stmt(`INSERT INTO bookings (id,ride,passenger,status,message,reply,created) SELECT ?,?,?,'pending',?,'',? WHERE EXISTS (SELECT 1 FROM rides WHERE id=? AND status='scheduled' AND datetime(date || 'T' || time || ':00','-5 hours')>datetime('now')) AND (SELECT COUNT(*) FROM bookings WHERE ride=? AND status='approved') < (SELECT seats FROM rides WHERE id=?) ON CONFLICT(ride,passenger) DO UPDATE SET status='pending',message=excluded.message,reply='',created=excluded.created WHERE bookings.status IN ('cancelled','declined')`,crypto.randomUUID(),id,uid,message,Date.now(),id,id,id).run();
  if(!result.meta.changes)return fail('This ride is full, has departed, or you already have a request.');return json({ok:true});
 }
 if(action==='cancelBooking'){
  if(!booking||!['pending','approved'].includes(booking.status))return fail('No active booking found.');
  if(!['scheduled','enroute','arrived'].includes(ride.status))return fail('Cancellation is available before the trip starts.');
  await db().batch([stmt(`UPDATE bookings SET status='cancelled' WHERE ride=? AND passenger=? AND EXISTS (SELECT 1 FROM rides WHERE id=? AND status IN ('scheduled','enroute','arrived'))`,id,uid,id),stmt('DELETE FROM shares WHERE ride=? AND owner=?',id,uid),stmt('UPDATE rides SET version=version+1 WHERE id=?',id)]);return json({ok:true});
 }
 if(action==='approve'||action==='decline'){
  if(!own)return fail('Only the driver can decide requests.',403);if(!['scheduled','enroute','arrived'].includes(ride.status))return fail('The passenger list is closed.');
  const bookingId=str(input.bookingId,64),reply=str(input.reply??'',600,false);
  const result=await stmt(`UPDATE bookings SET status=?,reply=? WHERE id=? AND ride=? AND status='pending' AND EXISTS (SELECT 1 FROM rides WHERE id=? AND status IN ('scheduled','enroute','arrived')) AND (?='declined' OR (SELECT COUNT(*) FROM bookings WHERE ride=? AND status='approved') < (SELECT seats FROM rides WHERE id=?))`,action==='approve'?'approved':'declined',reply,bookingId,id,id,action==='approve'?'approved':'declined',id,id).run();
  if(!result.meta.changes)return fail('No seat available or the request has already changed.');await stmt('UPDATE rides SET version=version+1 WHERE id=?',id).run();return json({ok:true});
 }
 if(action==='status'){
  if(!own)return fail('Only the driver can control the trip.',403);const status=str(input.status,20);if(!canTransition(ride.status,status))return fail('This trip status cannot be changed that way.');
  const terminal=['ended','cancelled'].includes(status);await db().batch([stmt('UPDATE rides SET status=?,version=version+1,sharing=CASE WHEN ? THEN 0 ELSE sharing END,lat=CASE WHEN ? THEN NULL ELSE lat END,lng=CASE WHEN ? THEN NULL ELSE lng END,updated=CASE WHEN ? THEN NULL ELSE updated END WHERE id=? AND status=?',status,terminal?1:0,terminal?1:0,terminal?1:0,terminal?1:0,id,ride.status),...(terminal?[stmt('DELETE FROM shares WHERE ride=?',id)]:[])]);return json({ok:true});
 }
 if(action==='location'){
  if(!own||!['enroute','arrived','started'].includes(ride.status))return fail('Location sharing is available to the driver during pickup and the trip.',403);
  if(input.stop===true){await stmt('UPDATE rides SET sharing=0,lat=NULL,lng=NULL,accuracy=NULL,updated=NULL WHERE id=?',id).run();return json({ok:true});}
  const lat=num(input.lat,-90,90),lng=num(input.lng,-180,180),accuracy=num(input.accuracy,0,1000000);
  await stmt(`UPDATE rides SET lat=?,lng=?,accuracy=?,updated=?,sharing=1 WHERE id=? AND status IN ('enroute','arrived','started')`,lat,lng,accuracy,Date.now(),id).run();return json({ok:true});
 }
 if(action==='share'||action==='revokeShare'){
  if(!own&&booking?.status!=='approved')return fail('Only approved travellers may share this trip.',403);
  if(action==='revokeShare'){await stmt('DELETE FROM shares WHERE ride=? AND owner=?',id,uid).run();return json({ok:true});}
  if(ride.status!=='started')return fail('Trip links become available once the trip starts.');
  const token=crypto.randomUUID()+crypto.randomUUID();await db().batch([stmt('DELETE FROM shares WHERE ride=? AND owner=?',id,uid),stmt('INSERT INTO shares (token,ride,owner,expires) VALUES (?,?,?,?)',await hash(token),id,uid,Date.now()+12*3600000)]);return json({token});
 }
 return fail('Unknown action.',404);
 }catch(e){if(e instanceof SyntaxError)return fail('Invalid request.');const message=e instanceof Error?e.message:'Unable to save changes.';if(/D1|SQLITE|database|Storage/.test(message)){console.error('Storage failed',e);return fail('Unable to save right now. Your input has been kept. Please retry.',503);}return fail(message);}
}
