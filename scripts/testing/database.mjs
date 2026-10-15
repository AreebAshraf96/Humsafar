import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
export async function createTestDatabase() {
 const db = new PGlite();
 await db.exec(`create role anon; create role authenticated; create schema auth;
 create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create schema storage;
 create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null references storage.buckets(id),name text not null,metadata jsonb default '{}',unique(bucket_id,name));
 alter table storage.objects enable row level security;
 create function storage.foldername(p_name text) returns text[] language sql immutable as $$
   select case when array_length(string_to_array(p_name,'/'),1)>1 then (string_to_array(p_name,'/'))[1:array_length(string_to_array(p_name,'/'),1)-1] else array[]::text[] end
 $$;
 grant usage on schema auth,storage to anon,authenticated;
 grant execute on function auth.uid(),storage.foldername(text) to anon,authenticated;
 grant select,insert,delete on storage.objects to authenticated;`);
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
