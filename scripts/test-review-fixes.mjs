import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { createTestDatabase } from './testing/database.mjs';
import { loadTs } from './testing/load-ts.mjs';
const {db,asUser,rpc}=await createTestDatabase();
const driver='00000000-0000-4000-8000-000000000041', passenger='00000000-0000-4000-8000-000000000042', stranger='00000000-0000-4000-8000-000000000043', unverified='00000000-0000-4000-8000-000000000044', admin='00000000-0000-4000-8000-000000000045';
const listing={originPoint:{id:'a',label:'Clifton',address:'Karachi',lat:24.80,lng:67.03,source:'pin'},destinationPoint:{id:'b',label:'Office',address:'Karachi',lat:24.85,lng:67.01,source:'pin'},date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'23:00',seats:2,fare:null,car:'Test',plate:'TEST',pickup:'Gate',dropoff:'Gate',days:[]};
const realFetch=globalThis.fetch;
try {
 // Simulate an older migration being run after the expiry fix. The independent
 // current-approval guard must still reject expired/revoked drivers.
 const original=readFileSync(new URL('../supabase/migrations/20261015_driver_verification.sql',import.meta.url),'utf8');
 const start=original.indexOf('create or replace function public.humsafar_check_driver_verified()');
 await db.exec(original.slice(start,original.indexOf('$$;',start)+3));
 for(const id of [driver,passenger,stranger,unverified,admin]) await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)',[id,id+'@test.invalid',id===unverified?null:new Date().toISOString()]);
 await rpc(driver,'profile',{name:'Driver',gender:'Not specified',phone:''});
 await rpc(passenger,'profile',{name:'Passenger',gender:'Not specified',phone:''});
 assert.equal((await asUser(unverified,'select id,name from public.profiles')).rows.length,0,'unverified users cannot enumerate names');
 assert.deepEqual((await asUser(stranger,'select id,name from public.profiles')).rows.map(p=>p.id),[stranger],'unrelated profiles are hidden');
 await db.query("insert into public.driver_verifications(user_id,status,licence_expiry_date) values($1,'approved',current_date+365)",[driver]);
 await rpc(driver,'create',listing);
 const ride=(await rpc(passenger,'rides',{date:listing.date})).rides[0];
 await rpc(passenger,'request',{id:ride.id});
 const booking=(await rpc(driver,'detail',{id:ride.id})).requests[0];
 await rpc(driver,'approve',{id:ride.id,bookingId:booking.id});
 for(let i=1;i<=125;i++) await asUser(driver,'insert into public.ride_messages(id,ride_id,sender_id,body,created_at) values($1,$2,$3,$4,$5)',[`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,ride.id,driver,String(i),'2026-11-01T12:00:00.123456Z']);
 assert.equal((await asUser(passenger,'select id,name from public.profiles where id=$1',[driver])).rows[0].name,'Driver','chat participants resolve message authors');
 const {ApiError}=await loadTs('lib/supabase-server.ts');
 const {GET}=await loadTs('app/api/chat/route.ts',{ApiError,waitUntil(){},sendManyHumsafarNotifications:async()=>{}});
 process.env.NEXT_PUBLIC_SUPABASE_URL='https://test.invalid';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test';
 globalThis.fetch=async(raw,options={})=>{
  const url=new URL(raw);
  if(url.pathname==='/auth/v1/user')return Response.json({id:passenger,email_confirmed_at:'yes'});
  if(url.pathname==='/rest/v1/ride_messages'){
   const cursor=url.searchParams.get('or');let before='ffffffff-ffff-ffff-ffff-ffffffffffff';
   if(cursor)before=cursor.match(/id.lt.([0-9a-f-]+)/)[1];
   assert.equal(url.searchParams.get('order'),'created_at.desc,id.desc');
   return Response.json((await asUser(passenger,'select id,sender_id,body,created_at::text as created_at from public.ride_messages where ride_id=$1 and id<$2 order by created_at desc,id desc limit 101',[ride.id,before])).rows.map(m=>({...m,created_at:m.created_at.replace(' ','T').replace(/([+-]\d{2})$/, '$1:00')})));
  }
  if(url.pathname==='/rest/v1/ride_message_reads') return options.method==='POST'?new Response(null,{status:204}):Response.json([]);
  if(url.pathname==='/rest/v1/profiles')return Response.json((await asUser(passenger,'select id,name from public.profiles')).rows);
  throw new Error('Unexpected URL '+url);
 };
 const request=before=>new Request('https://app.invalid/api/chat?'+new URLSearchParams({rideId:ride.id,...(before?{before}:{})}),{headers:{Authorization:'Bearer test'}});
 const first=await (await GET(request())).json();
 assert.equal(first.messages.length,100);assert.equal(first.messages.at(-1).body,'125');assert.equal(first.messages[0].body,'26');assert.ok(first.nextCursor);
 const older=await (await GET(request(first.nextCursor))).json();assert.ok(older.messages,JSON.stringify({older,cursor:first.nextCursor}));assert.equal(older.messages.length,25);assert.equal(older.messages[0].body,'1');assert.equal(older.nextCursor,null);
 assert.equal((await GET(request('{bad'))).status,400);
 // Cancellation must free the upcoming-departure quota.
 for(let i=0;i<101;i++){await rpc(driver,'create',listing);const rides=await rpc(driver,'rides',{date:listing.date});const latest=rides.rides.find(r=>r.id!==ride.id);await rpc(driver,'status',{id:latest.id,status:'cancelled'});}
 await rpc(driver,'create',listing);
 await db.query("update public.driver_verifications set licence_expiry_date=current_date-1 where user_id=$1",[driver]);
 await assert.rejects(()=>rpc(driver,'create',listing),e=>e.code==='42501');
 const prefix=driver+'/11111111-1111-4111-8111-111111111111';
 await asUser(driver,"insert into storage.objects(bucket_id,name) values('driver-verification',$1),('driver-verification',$2)",[prefix+'/licence.jpg',prefix+'/selfie.jpg']);
 const application=(await asUser(driver,'select public.humsafar_submit_driver_verification($1,$2,$3) as value',[prefix+'/licence.jpg',prefix+'/selfie.jpg','TEST'])).rows[0].value;
 await db.query('insert into public.driver_verification_admins(user_id) values($1)',[admin]);
 await assert.rejects(()=>asUser(admin,"select public.humsafar_review_driver_verification($1,'approved','')",[application.id]),e=>e.code==='22023');
 await asUser(admin,"select public.humsafar_review_driver_verification($1,'approved','',current_date+365)",[application.id]);
 await asUser(admin,"select public.humsafar_review_driver_verification($1,'action_required','Approval revoked')",[application.id]);
 await assert.rejects(()=>rpc(driver,'create',listing),e=>e.code==='42501');
 const state=(await db.query('select status,automated_result from public.driver_verifications where id=$1',[application.id])).rows[0];assert.equal(state.status,'action_required');assert.equal(state.automated_result.state,'unavailable');
 console.log('Review regressions passed: private names, latest/older chat with tied timestamps, invalid cursors, cancelled-ride quota, expired approval, resubmission, mandatory expiry and admin revocation.');
} finally {globalThis.fetch=realFetch;await db.close();}
