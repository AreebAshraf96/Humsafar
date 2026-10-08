import assert from 'node:assert/strict';
import { loadTs } from './testing/load-ts.mjs';
const values=new Map();globalThis.window={};globalThis.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
process.env.NEXT_PUBLIC_SUPABASE_URL='https://test.supabase.invalid';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='public-test';
const auth=await loadTs('lib/supabase-auth.ts');
const old={access_token:'old',refresh_token:'refresh-old',expires_at:1,user:{id:'test'}};
const next={...old,access_token:'new',refresh_token:'refresh-new',expires_at:Date.now()/1000+3600};
let resolve;let calls=0;const realFetch=globalThis.fetch;
globalThis.fetch=()=>{calls++;return new Promise(r=>{resolve=r})};
try{
 auth.saveSession(old);const a=auth.validSession(),b=auth.validSession();assert.equal(calls,1);resolve(Response.json(next));assert.deepEqual(await a,next);assert.deepEqual(await b,next);
 auth.saveSession(old);const pending=auth.validSession();auth.saveSession(null);resolve(Response.json(next));assert.equal(await pending,null);assert.equal(auth.getStoredSession(),null,'late refresh never restores logged-out session');
 console.log('Session checks passed: one refresh for concurrent requests and no session resurrection after logout.');
}finally{globalThis.fetch=realFetch;delete globalThis.window;delete globalThis.localStorage;}
