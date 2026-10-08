import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
export async function createTestDatabase() {
 const db = new PGlite();
 await db.exec(`create role anon; create role authenticated; create schema auth;
 create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
 for (const file of readdirSync(new URL('../../supabase/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) {
   // PGlite supplies gen_random_uuid and sha256 in core; no pgcrypto extension needed.
   const sql=readFileSync(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8').replace('create extension if not exists pgcrypto;','');
   try { await db.exec(sql); } catch(e) { throw new Error(`${file}: ${e.message}`, {cause:e}); }
 }
 async function asUser(id,sql,params=[]) {
   return db.transaction(async tx=>{
     await tx.exec('set local role '+(id ? 'authenticated':'anon'));
     await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[id||'']);
     return tx.query(sql,params);
   });
 }
 async function rpc(id, action, input={}) {
   const r=await asUser(id,'select public.humsafar_api($1,$2::jsonb) as value',[action,JSON.stringify(input)]);
   return r.rows[0].value;
 }
 return {db,asUser,rpc};
}
