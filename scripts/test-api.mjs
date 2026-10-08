import assert from 'node:assert/strict';
import { loadTs } from './testing/load-ts.mjs';
const store=await loadTs('lib/supabase-server.ts');
const locations=await loadTs('lib/locations.ts');
const domain=await loadTs('lib/domain.ts');
const waiting=[];let sent=0;
const {GET,POST}=await loadTs('app/api/carpool/route.ts',{...store,...locations,...domain,waitUntil:p=>waiting.push(p),sendHumsafarNotification:async()=>{sent++;return true}});
process.env.NEXT_PUBLIC_SUPABASE_URL='https://test.supabase.invalid';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test-public-key';
const realFetch=globalThis.fetch;let calls=0;
globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer verified-test-token');return Response.json({ok:true,_notifications:[{userId:'test',title:'test',body:'test',category:'booking_updates'}]})};
const req=(action,token=true,origin='https://test.local',extra={})=>new Request('https://test.local/api/carpool',{method:'POST',headers:{Origin:origin,...(token?{Authorization:'Bearer verified-test-token'}:{})},body:JSON.stringify({action,...extra})});
try{
 for(const action of ['me','rides','detail','trips'])assert.equal((await GET(new Request('https://test.local/api/carpool?action='+action))).status,401);
 for(const action of ['track','profile','request','approve','location'])assert.equal((await POST(req(action,false))).status,401);
 assert.equal(calls,0,'anonymous requests never reach database');
 assert.equal((await POST(req('profile',true,'https://evil.invalid'))).status,403);
 assert.equal(calls,0);
 const result=await POST(req('approve'));assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true});assert.equal(waiting.length,1,'notification attached to Worker lifetime');await Promise.all(waiting);assert.equal(sent,1);
 assert.equal((await POST(req('profile',true,'https://test.local',{name:'x'.repeat(22000)}))).status,413);
 globalThis.fetch=async()=>Response.json({code:'42501',message:'Only the driver can do that.'},{status:403});assert.equal((await POST(req('approve'))).status,403);
 globalThis.fetch=async()=>Response.json({code:'P0002',message:'Expired'},{status:400});assert.equal((await POST(req('track'))).status,404);
 globalThis.fetch=async()=>Response.json({code:'28000',message:'Unverified'},{status:400});assert.equal((await POST(req('profile'))).status,401);
 console.log('API checks passed: login enforcement, same-origin requests, bounded payloads, SQL error mapping and notification lifetime.');
}finally{globalThis.fetch=realFetch;}
