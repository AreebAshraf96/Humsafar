/** Local review only: real Supabase login, disposable PostgreSQL ride records.
 * Never deploy this process. It binds only to loopback and verifies every token
 * with the configured Supabase Auth before touching its in-memory database.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createTestDatabase } from './testing/database.mjs';
const project=process.env.NEXT_PUBLIC_SUPABASE_URL;
const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if(!project||!key)throw new Error('Load .env.local with your existing Supabase public configuration first.');
const {db,rpc}=await createTestDatabase();
const originPoint={id:'demo:clifton',label:'Dolmen Mall Clifton',address:'Clifton, Karachi',lat:24.8021172,lng:67.0302623,source:'pin'};
const destinationPoint={id:'demo:ubl',label:'UBL City Building',address:'I. I. Chundrigar Road, Karachi',lat:24.8492715,lng:67.0013189,source:'pin'};
const driver='00000000-0000-4000-8000-000000000011';
await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'driver@example.test',now())",[driver]);
await rpc(driver,'profile',{name:'Demo driver — Sana',gender:'Woman',phone:''});
const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
await rpc(driver,'create',{originPoint,destinationPoint,date:tomorrow,time:'08:30',seats:3,fare:350,car:'White Toyota Corolla · DEMO',plate:'DEMO-001',pickup:'Mall main entrance',dropoff:'Office entrance',notes:'Sample ride for the review demo. Not a real offer.',days:[]});
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
try{await rpc(driver,'create',{originPoint,destinationPoint,date:today,time:'23:59',seats:3,fare:350,car:'White Toyota Corolla · DEMO',plate:'DEMO-002',pickup:'Mall main entrance',dropoff:'Office entrance',notes:'Sample ride for the review demo. Not a real offer.',days:[]});}catch{}
const server=createServer(async(req,res)=>{
 const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 try{
  if(req.method!=='POST'||req.url!=='/rest/v1/rpc/humsafar_api')return send(404,{error:'Not found'});
  const auth=await fetch(project+'/auth/v1/user',{headers:{apikey:key,Authorization:req.headers.authorization||''},signal:AbortSignal.timeout(10000)});
  if(!auth.ok)return send(401,{code:'28000'});
  const user=await auth.json();
  if(!user.id||!user.email_confirmed_at)return send(401,{code:'28000'});
  // Copy only the user ID needed for ownership; never store their password,
  // access token or real email in the demo database.
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()) on conflict(id) do nothing",[user.id,user.id+'@preview.invalid']);
  let body='';for await(const chunk of req){body+=chunk;if(body.length>20000)return send(413,{error:'Too large'});}
  const {p_action,p_input}=JSON.parse(body);
  const result=await rpc(user.id,p_action,p_input);delete result._notifications;
  send(200,result);
 }catch(e){send(e.code==='42501'?403:400,{code:e.code||'22023',message:e.code?e.message:'Invalid request'});}
});
await new Promise(resolve=>server.listen(54329,'127.0.0.1',resolve));
const child=spawn(process.execPath,['scripts/run-framework.mjs','dev','--port','5174'],{
 stdio:'inherit',env:{...process.env,HUMSAFAR_PREVIEW_RPC_URL:'http://127.0.0.1:54329',NEXT_PUBLIC_PREVIEW_MODE:'true',NODE_ENV:'development'},
});
child.on('exit',async code=>{server.close();await db.close();process.exit(code||0)});
process.on('SIGINT',()=>child.kill('SIGINT'));
console.log('Review demo: http://localhost:5174 — real Supabase sign-in, isolated sample rides.');
