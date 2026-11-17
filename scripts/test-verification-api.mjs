import assert from 'node:assert/strict';
import { loadTs } from './testing/load-ts.mjs';
const {DriverVerificationError,verificationFailure,readVerificationJson}=await loadTs('lib/driver-verification-server.ts');
const userId='00000000-0000-4000-8000-000000000051';
const prefix=userId+'/11111111-1111-4111-8111-111111111111';
const licencePath=prefix+'/licence.jpg',selfiePath=prefix+'/selfie.jpg';
let row,patches=0,scenario;let expectedLicence=licencePath;const cleaned=[];
const reset=()=>row={id:'00000000-0000-4000-8000-000000000052',user_id:userId,status:'pending',submitted_at:'2026-11-17T01:00:00.123456+00:00',licence_storage_path:licencePath,selfie_storage_path:selfiePath,licence_expiry_date:null,automated_result:{state:'unavailable'}};
const {POST}=await loadTs('app/api/driver-verification/route.ts',{
 DriverVerificationError,verificationFailure,readVerificationJson,
 verificationContext:async()=>({userId}),
 readStoredImage:async()=>new Blob(['image']),
 runAutomatedVerification:async()=>({state:'needs_review',checkedAt:'2026-11-17T02:00:00Z'}),
 supabaseRequest:async(context,path,options)=>{
  if(path.includes('humsafar_submit_driver_verification')){const args=JSON.parse(options.body);assert.equal(args.p_selfie_path,selfiePath);row.status='pending';row.licence_storage_path=args.p_licence_path;return {...row,old_licence_storage_path:licencePath,old_selfie_storage_path:selfiePath};}
  if(path.startsWith('/storage/')){cleaned.push(...JSON.parse(options.body).prefixes);return null;}
  return [{...row}];
 },
 serviceRoleRequest:async(context,path,options)=>{
  patches++;
  const query=new URL('https://test.invalid'+path).searchParams;
  const body=JSON.parse(options.body);
  assert.equal(body.status,undefined,'automation cannot mutate review status');
  assert.equal(body.licence_expiry_date,undefined,'automation cannot erase human-confirmed expiry');
  assert.equal(query.get('status'),'eq.pending');
  assert.equal(query.get('licence_storage_path'),'eq.'+expectedLicence);
  assert.equal(query.get('selfie_storage_path'),'eq.'+selfiePath);
  assert.equal(query.get('submitted_at'),'eq.2026-11-17T01:00:00.123456+00:00');
  if(scenario==='review'){row.status='approved';row.licence_expiry_date='2099-12-31';}
  if(scenario==='resubmission'){row.submitted_at='2026-11-17T03:00:00Z';row.automated_result={state:'unavailable',reasonCode:'new_submission'};}
  if(row.status!=='pending'||query.get('submitted_at')!=='eq.'+row.submitted_at)return [];
  Object.assign(row,body);return [{id:row.id}];
 },
});
const old=process.env.SUPABASE_SERVICE_ROLE_KEY;process.env.SUPABASE_SERVICE_ROLE_KEY='test-only-placeholder';process.env.DRIVER_VERIFICATION_MODEL_URL='http://127.0.0.1:8000/verify';process.env.DRIVER_VERIFICATION_MODEL_KEY='test-placeholder';
const request=action=>new Request('https://app.invalid/api/driver-verification',{method:'POST',body:JSON.stringify({action,licencePath,selfiePath,registration:'TEST'})});
try {
 reset();row.status='rejected';scenario='review';
 let response=await POST(request('submit'));assert.equal(response.status,200);let data=await response.json();assert.equal(data.status,'approved');assert.equal(data.licence_expiry_date,'2099-12-31');
 reset();scenario='resubmission';response=await POST(request('retry_automation'));data=await response.json();assert.equal(data.automated_result.reasonCode,'new_submission');
 reset();scenario='normal';response=await POST(request('retry_automation'));data=await response.json();assert.equal(data.automated_result.state,'needs_review');assert.equal(patches,3);
 reset();row.automated_result={state:'needs_review'};scenario='normal';response=await POST(request('retry_automation'));assert.equal(response.status,200,'Existing pending applications without document checks can be upgraded');
 reset();scenario='normal';expectedLicence=prefix+'/licence.png';response=await POST(new Request('https://app.invalid/api/driver-verification',{method:'POST',body:JSON.stringify({action:'submit',licencePath:expectedLicence,replaceSubmittedAt:row.submitted_at,registration:'TEST'})}));assert.equal(response.status,200);assert.equal(row.selfie_storage_path,selfiePath);assert.ok(!cleaned.includes(selfiePath),'unchanged selfie is not deleted');
 reset();row.status='approved';response=await POST(new Request('https://app.invalid/api/driver-verification',{method:'POST',body:JSON.stringify({action:'submit',licencePath:expectedLicence,replaceSubmittedAt:row.submitted_at,registration:'TEST'})}));assert.equal(response.status,409,'concurrent review blocks replacement');
 console.log('Verification API regressions passed: concurrent review preserved, stale submission results discarded, normal retry saved.');
} finally {if(old===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=old;}
