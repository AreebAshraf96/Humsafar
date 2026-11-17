import assert from 'node:assert/strict';
import {loadTs} from './testing/load-ts.mjs';
const server=await loadTs('lib/driver-verification-server.ts');
const {runAutomatedVerification}=await loadTs('lib/driver-verification-automation.ts');
const originalEnv={...process.env},realFetch=globalThis.fetch;
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++};
const denied=async(fn,status)=>{await assert.rejects(fn,error=>error.status===status);checks++};
const context={url:'https://test.invalid',key:'public-placeholder',authorization:'Bearer user-token',userId:'user'};
const image=new Blob([Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0])],{type:'image/png'});
try{
 process.env.NEXT_PUBLIC_SUPABASE_URL=context.url;process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=context.key;
 await denied(()=>server.verificationContext(new Request('https://app.invalid')),401);
 const authorized=()=>new Request('https://app.invalid',{headers:{Authorization:'Bearer token'}});
 globalThis.fetch=async()=>Response.json({id:'user',email_confirmed_at:null});await denied(()=>server.verificationContext(authorized()),401);
 globalThis.fetch=async()=>{throw new Error('network')};await denied(()=>server.verificationContext(authorized()),503);
 globalThis.fetch=async()=>Response.json({id:'user',email_confirmed_at:'yes'});check((await server.verificationContext(authorized())).userId==='user','verified user accepted');
 for(const input of ['null','[]','42','"text"','{bad']){
  try{await server.readVerificationJson(new Request('https://app.invalid',{method:'POST',body:input}));assert.fail('invalid JSON accepted')}catch(error){check(error.status===400||error instanceof SyntaxError,'invalid payload rejected')}
 }
 await denied(()=>server.readVerificationJson(new Request('https://app.invalid',{method:'POST',headers:{Origin:'https://evil.invalid'},body:'{}'})),403);
 await denied(()=>server.readVerificationJson(new Request('https://app.invalid',{method:'POST',body:'x'.repeat(20001)})),413);
 check((await server.readVerificationJson(new Request('https://app.invalid',{method:'POST',body:'{"action":"submit"}'}))).action==='submit','valid JSON accepted');
 check(await server.validImageBytes(image),'PNG signature accepted');
 check(!await server.validImageBytes(new Blob(['bad'],{type:'image/png'})),'invalid image bytes rejected');
 check(!server.isAllowedImage(new File([],'empty.png',{type:'image/png'})),'empty file rejected');
 check(!server.isAllowedImage(new File(['x'],'bad.pdf',{type:'application/pdf'})),'wrong file type rejected');
 globalThis.fetch=async()=>new Response('missing',{status:404});await denied(()=>server.readStoredImage(context,'test/does-not-exist.png'),400);
 globalThis.fetch=async()=>new Response('bad',{headers:{'Content-Type':'image/png'}});await denied(()=>server.readStoredImage(context,'test/corrupt.png'),400);
 for(const [key,expectBearer] of [['sb_secret_placeholder',false],['legacy-placeholder',true]]){
  delete process.env.SUPABASE_SECRET_KEY;process.env.SUPABASE_SERVICE_ROLE_KEY=key;
  globalThis.fetch=async(url,options)=>{check(options.headers.apikey===key,'server key on apikey');check(!!options.headers.Authorization===expectBearer,'correct legacy/new authorization headers');return new Response(null,{status:204})};
  await server.serviceRoleRequest(context,'/rest/v1/driver_verifications',{method:'PATCH',body:'{}'});
 }
 delete process.env.DRIVER_VERIFICATION_MODEL_URL;delete process.env.DRIVER_VERIFICATION_MODEL_KEY;
 check((await runAutomatedVerification(context,image,image)).reasonCode==='model_not_configured','missing model handled');
 process.env.DRIVER_VERIFICATION_MODEL_KEY='model-placeholder';process.env.DRIVER_VERIFICATION_MODEL_URL='file:///private';check((await runAutomatedVerification(context,image,image)).reasonCode==='model_endpoint_invalid','invalid model endpoint handled');
 process.env.NODE_ENV='production';process.env.DRIVER_VERIFICATION_MODEL_URL='http://127.0.0.1:8000/verify';check((await runAutomatedVerification(context,image,image)).reasonCode==='model_endpoint_must_use_https','production requires HTTPS');
 process.env.NODE_ENV='development';globalThis.fetch=async()=>{throw new Error('offline')};check((await runAutomatedVerification(context,image,image)).reasonCode==='model_unreachable','offline model handled');
 globalThis.fetch=async()=>new Response(null,{status:503});check((await runAutomatedVerification(context,image,image)).reasonCode==='model_request_failed','model service errors handled');
 for(const output of [null,[],{}, {faceMatchStatus:'unknown'}, {faceMatchStatus:'match',faceMatchScore:2},{faceMatchStatus:'match',faceMatchScore:null},{faceMatchStatus:'no_face',faceMatchScore:0.5}]){
  globalThis.fetch=async()=>Response.json(output);check((await runAutomatedVerification(context,image,image)).state==='unavailable','invalid model response fails closed');
 }
 globalThis.fetch=async()=>new Response('{bad');check((await runAutomatedVerification(context,image,image)).state==='unavailable','malformed model JSON handled');
 globalThis.fetch=async()=>Response.json({faceMatchStatus:'match',faceMatchScore:0.8});process.env.DRIVER_VERIFICATION_FACE_MIN_SCORE='NaN';check((await runAutomatedVerification(context,image,image)).reasonCode==='threshold_configuration_invalid','invalid threshold handled');
 process.env.DRIVER_VERIFICATION_FACE_MIN_SCORE='0.383';let output=await runAutomatedVerification(context,image,image);check(output.state==='needs_review'&&output.reasonCode==='face_match_passed_license_review_required','face match never automatically approves');
 globalThis.fetch=async()=>Response.json({faceMatchStatus:'no_face',faceMatchScore:null});output=await runAutomatedVerification(context,image,image);check(output.state==='needs_review'&&output.faceMatchStatus==='no_face','no-face result sent to human review');
 globalThis.fetch=async()=>Response.json({faceMatchStatus:'match',faceMatchScore:0.8,documentChecks:{state:'review_required',expiryDate:'2030-12-31',expiryStatus:'valid',nameStatus:'consistent',licenceNumberPresent:true,reasons:['Printed name appears consistent.'],rawText:'DO NOT STORE TRANSCRIPT',name:'Alex Private',licenceNumber:'PRIVATE123'}});
 output=await runAutomatedVerification(context,image,image,{declaredName:'Alex Private'});
 check(output.documentChecks?.expiryDate==='2030-12-31','document expiry retained for review');
 check(output.documentChecks?.nameStatus==='consistent','name consistency outcome retained');
 check(!JSON.stringify(output).includes('Alex Private')&&!JSON.stringify(output).includes('PRIVATE123')&&!JSON.stringify(output).includes('TRANSCRIPT'),'raw OCR/private fields discarded');
 console.log(`${checks} verification validation checks passed: authentication, bounded JSON, image validation, key types, offline/malformed models, thresholds and manual approval.`);
}finally{globalThis.fetch=realFetch;for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];Object.assign(process.env,originalEnv);}
