// Explicit opt-in: creates labelled temporary accounts/documents, then removes
// only those fixtures. Never uses an existing user's identity or documents.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
if (!process.argv.includes('--live')) throw new Error('Live test requires explicit --live opt-in.');
const root=resolve(import.meta.dirname,'..');
const base=process.env.HUMSAFAR_TEST_BASE_URL||'http://localhost:5173';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Run against the local app only.');
const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/,'');
const publicKey=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serverKey=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!publicKey||!serverKey)throw new Error('Supabase public/server configuration is missing.');
const serverHeaders={apikey:serverKey,...(serverKey.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${serverKey}`})};
const runId=randomUUID().slice(0,8),checks=[];
const directory=resolve(root,'work/verification-results');mkdirSync(directory,{recursive:true});
const manifestPath=resolve(directory,'cleanup.json');
let fixtures={users:[],paths:[]};let browser;
const record=message=>{checks.push(message);console.log('PASS '+message)};
async function request(path,{token,server=false,method='GET',body,headers={}}={}){
 const response=await fetch((path.startsWith('http')?path:url+path),{method,headers:{...(server?serverHeaders:{apikey:publicKey,...(token?{Authorization:`Bearer ${token}`}:{})}),...(body&&!(body instanceof Uint8Array)?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:body instanceof Uint8Array||typeof body==='string'?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(90000)});
 let data;try{data=await response.json()}catch{data=null}return {status:response.status,ok:response.ok,data};
}
const save=()=>{writeFileSync(manifestPath,JSON.stringify(fixtures));writeFileSync(resolve(directory,`fixtures-${runId}.json`),JSON.stringify(fixtures));};
async function cleanup(){
 const failures=[];
 for(const user of fixtures.users){
  const check=await request('/auth/v1/admin/users/'+user.id,{server:true});
  if(check.status===404)continue;
  if(!check.ok||!check.data?.email?.startsWith('humsafar-verification-test-')){failures.push('Refused unknown account');continue;}
  // Browser uploads choose their own UUID paths. Enumerate only this known
  // test account's directory before removing the account itself.
  const paths=fixtures.paths.filter(p=>p.startsWith(user.id+'/'));
  const folders=await request('/storage/v1/object/list/driver-verification',{server:true,method:'POST',body:{prefix:user.id+'/',limit:1000}});
  if(!folders.ok){failures.push('Could not list test documents');continue;}
  for(const folder of folders.data||[]){
   if(folder.id){paths.push(user.id+'/'+folder.name);continue;}
   const files=await request('/storage/v1/object/list/driver-verification',{server:true,method:'POST',body:{prefix:user.id+'/'+folder.name+'/',limit:1000}});
   if(!files.ok){failures.push('Could not list test document folder');continue;}
   for(const file of files.data||[])if(file.id)paths.push(user.id+'/'+folder.name+'/'+file.name);
  }
  if(paths.length){const removed=await request('/storage/v1/object/driver-verification',{server:true,method:'DELETE',body:{prefixes:paths}});if(!removed.ok)failures.push('Storage cleanup failed');}
  const rides=await request('/rest/v1/rides?driver=eq.'+user.id,{server:true,method:'DELETE'});if(!rides.ok)failures.push('Ride cleanup failed');
  const removed=await request('/auth/v1/admin/users/'+user.id,{server:true,method:'DELETE'});if(!removed.ok)failures.push('Account cleanup failed');
 }
 if(failures.length)throw new Error(failures.join('; '));
 if(existsSync(manifestPath))unlinkSync(manifestPath);
}
async function app(path,token,body){return request(base+path,{token,...(body!==undefined?{method:'POST',body}:{}),headers:{Origin:base}})}
async function makeUser(role){
 const email=`humsafar-verification-test-${runId}-${role}@example.invalid`,password=randomBytes(32).toString('base64url');
 const created=await request('/auth/v1/admin/users',{server:true,method:'POST',body:{email,password,email_confirm:true,user_metadata:{name:'AUTOMATED VERIFICATION TEST'}}});
 assert.ok(created.ok,`Create temporary ${role}: HTTP ${created.status}`);const user={id:created.data.id,email,role};fixtures.users.push(user);save();
 const signed=await request('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});assert.ok(signed.ok,'Sign in temporary '+role);return {...user,session:signed.data,token:signed.data.access_token};
}
async function driverForm(page){
 await page.locator('#licence-image').setInputFiles(resolve(root,'work/verification-fixtures/test-card.png'));
 await page.locator('#selfie-image').setInputFiles(resolve(root,'work/verification-fixtures/lena.jpg'));
 await page.locator('input[name=declaredName]').fill('AUTOMATED TEST NAME');
 await page.locator('input[name=vehicleRegistration]').fill('TEST-'+runId.toUpperCase());
 await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:/^(Submit|Resubmit) for review$/}).click();
 await page.getByText('Pending review',{exact:true}).waitFor({timeout:90000});
}
try{
 if(existsSync(manifestPath)){fixtures=JSON.parse(readFileSync(manifestPath,'utf8'));await cleanup();fixtures={users:[],paths:[]};}
 assert.equal((await fetch('http://127.0.0.1:8000/health')).status,200,'Local model must be running');
 const driver=await makeUser('driver'),admin=await makeUser('admin'),outsider=await makeUser('outsider');
 assert.ok((await request('/rest/v1/driver_verification_admins',{server:true,method:'POST',body:{user_id:admin.id}})).ok,'Grant temporary reviewer');
 assert.equal((await app('/api/driver-verification')).status,401);record('Unauthenticated verification access denied');
 const initial=await app('/api/driver-verification',driver.token);assert.equal(initial.data.status,'not_submitted');assert.equal(initial.data.automation_available,true,'Restart the local app after configuring model and server key.');
 for(const body of [null,[],{action:'unknown'}]){const result=await request(base+'/api/driver-verification',{token:driver.token,method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});assert.equal(result.status,400);}
 record('Malformed and unknown verification requests rejected');
 assert.ok((await app('/api/carpool',driver.token,{action:'profile',name:'AUTOMATED VERIFICATION TEST',gender:'Not specified',phone:''})).ok);
 const listing={action:'create',originPoint:{id:'test:a',label:'TEST Clifton',address:'Karachi',lat:24.80,lng:67.03,source:'pin'},destinationPoint:{id:'test:b',label:'TEST Office',address:'Karachi',lat:24.85,lng:67.01,source:'pin'},date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'23:30',seats:1,car:'AUTOMATED TEST',plate:'TEST-'+runId.toUpperCase(),pickup:'TEST ONLY',dropoff:'TEST ONLY',fare:null,days:[],notes:'AUTOMATED TEST. NOT A REAL RIDE.'};
 assert.equal((await app('/api/carpool',driver.token,listing)).status,403);record('Unapproved driver cannot publish rides');
 const wrongPath=outsider.id+'/'+randomUUID()+'/licence.jpg';
 assert.equal((await app('/api/driver-verification',driver.token,{action:'submit',licencePath:wrongPath,selfiePath:wrongPath,registration:'TEST'})).status,400);record('Cross-account document paths rejected');
 const require=createRequire(import.meta.url);const {chromium}=require(resolve(root,'work/verification-browser/node_modules/playwright-core'));
 const executable=process.env.HUMSAFAR_BROWSER||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
 browser=await chromium.launch({executablePath:executable,headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const driverContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['camera']});
 await driverContext.addInitScript(session=>localStorage.setItem('humsafar.supabase.session',JSON.stringify(session)),driver.session);
 const page=await driverContext.newPage();page.setDefaultTimeout(60000);await page.goto(base+'/driver-verification',{waitUntil:'domcontentloaded',timeout:90000});
 await page.locator('#licence-image').waitFor({state:'attached'});
 assert.equal(await page.locator('#selfie-image').getAttribute('capture'),null,'Device picker must not force camera');
 await page.evaluate(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.__cameraStreams=[];navigator.mediaDevices.getUserMedia=async options=>{const stream=await original(options);window.__cameraStreams.push(stream);return stream;};});
 await page.getByRole('button',{name:'Take live selfie',exact:true}).click();
 const cameraDialog=page.getByRole('dialog',{name:'Selfie camera'});await cameraDialog.waitFor();
 await page.waitForFunction(()=>{const video=document.querySelector('dialog video');return video?.videoWidth>0});
 await cameraDialog.getByRole('button',{name:'Capture photo',exact:true}).click();
 await page.getByAltText('Selfie preview',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__cameraStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))),true,'Camera tracks stopped after capture');
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Test denial','NotAllowedError')};});
 await page.getByRole('button',{name:'Take live selfie',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Camera could not open'}).waitFor();
 record('Mobile camera capture, permission-denied fallback and separate file picker work');
assert.equal(await page.getByRole('button',{name:'Submit for review',exact:true}).isDisabled(),true);
 await page.locator('#licence-image').setInputFiles({name:'bad.pdf',mimeType:'application/pdf',buffer:Buffer.from('invalid')});await page.getByRole('alert').filter({hasText:'Choose a JPG'}).waitFor();
 await driverForm(page);await page.screenshot({path:resolve(directory,'driver-pending.png'),fullPage:true});record('Browser upload, consent and submission reach pending review');
 let application=(await app('/api/driver-verification',driver.token)).data;assert.equal(application.automated_result.state,'needs_review');assert.equal(application.automated_result.faceMatchStatus,'match');assert.ok(application.automated_result.documentChecks?.reasons?.length,'Document check reasons persisted');assert.equal(application.status,'pending','Checks cannot automatically grant driving access');record('Real local model result persisted in Supabase');
 const applicationId=application.id;
 assert.equal((await app('/api/verification-access',driver.token)).data.isAdmin,false);
 assert.equal((await app('/api/verification-access',admin.token)).data.isAdmin,true);record('Requests navigation is restricted to administrator accounts');
 const originalStamp=application.submitted_at;
 const beforePhotos=(await request('/rest/v1/driver_verifications?select=licence_storage_path,selfie_storage_path&id=eq.'+applicationId,{server:true})).data[0];
 await page.getByRole('button',{name:'Retake / replace photos',exact:true}).click();
 await page.locator('#licence-image').setInputFiles(resolve(root,'work/verification-fixtures/test-card.png'));
 await page.getByRole('checkbox').check();
 const replacement=page.waitForResponse(response=>response.url().endsWith('/api/driver-verification')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Submit replacement photos',exact:true}).click();assert.ok((await replacement).ok());
 application=(await app('/api/driver-verification',driver.token)).data;assert.equal(application.id,applicationId);assert.equal(application.status,'pending');
 const afterPhotos=(await request('/rest/v1/driver_verifications?select=licence_storage_path,selfie_storage_path&id=eq.'+applicationId,{server:true})).data[0];
 assert.notEqual(afterPhotos.licence_storage_path,beforePhotos.licence_storage_path);assert.equal(afterPhotos.selfie_storage_path,beforePhotos.selfie_storage_path);
 record('Unreadable details prompt retake; licence-only replacement preserves selfie and request');
 assert.equal((await app('/api/admin/driver-verifications',admin.token,{action:'review',id:applicationId,submittedAt:originalStamp,status:'approved',licenceExpiryDate:'2099-12-31'})).status,403);record('Administrator cannot approve a stale version of replaced photos');
 const legacy=await request('/rest/v1/driver_verifications?id=eq.'+applicationId,{server:true,method:'PATCH',body:{automated_result:{state:'needs_review',faceMatchStatus:'match',faceMatchScore:0.9,reasonCode:'legacy_test'}}});assert.ok(legacy.ok);
 await page.reload({waitUntil:'domcontentloaded',timeout:90000});
 await page.getByLabel('Full name as printed on licence',{exact:true}).fill('AUTOMATED TEST NAME');
 await page.getByRole('button',{name:'Run automatic checks',exact:true}).click();
 await page.getByText('The face comparison ran again. Your application remains pending for administrator review.',{exact:true}).waitFor({timeout:90000});
 application=(await app('/api/driver-verification',driver.token)).data;assert.ok(application.automated_result.documentChecks);
 record('Existing pending applications receive document checks without reuploading');
 assert.equal((await app('/api/driver-verification',driver.token,{action:'submit',licencePath:application.licence_storage_path||driver.id+'/'+randomUUID()+'/licence.jpg',selfiePath:driver.id+'/'+randomUUID()+'/selfie.jpg',registration:'TEST'})).status,409);
 assert.equal((await app('/api/admin/driver-verifications',outsider.token)).status,403);
 assert.equal((await app('/api/admin/driver-verifications',driver.token,{action:'review',id:applicationId,status:'approved',licenceExpiryDate:'2099-12-31'})).status,403);record('Duplicate submission and unauthorized administrator review denied');
 const adminContext=await browser.newContext({viewport:{width:1280,height:1000}});await adminContext.addInitScript(session=>localStorage.setItem('humsafar.supabase.session',JSON.stringify(session)),admin.session);
 const adminPage=await adminContext.newPage();
 await adminPage.route('**/api/admin/driver-verifications*',async route=>{
  if(route.request().method()!=='GET')return route.continue();
  const target=new URL(route.request().url());target.searchParams.set('id',applicationId);target.searchParams.set('limit','1');target.searchParams.set('offset','0');
  const response=await route.fetch({url:target.toString()});const data=await response.json();
  if(data.applications)data.applications=data.applications.filter(row=>row.id===applicationId&&(!target.searchParams.get('status')||row.status===target.searchParams.get('status')));
  await route.fulfill({response,json:data});
 });
 adminPage.setDefaultTimeout(60000);await adminPage.goto(base+'/admin/driver-verifications',{waitUntil:'domcontentloaded',timeout:90000});await adminPage.getByRole('button',{name:'Request changes',exact:true}).waitFor();await adminPage.getByRole('link',{name:'Requests',exact:true}).waitFor();assert.equal(await adminPage.getByRole('tab',{name:'Pending requests',exact:true}).getAttribute('aria-selected'),'true');
 await adminPage.getByLabel('Reason (required for reject or request changes)').fill('AUTOMATED TEST: please resubmit');await adminPage.getByRole('button',{name:'Request changes',exact:true}).click();
 await adminPage.getByText('Application action required.',{exact:true}).waitFor();
 await page.reload({waitUntil:'domcontentloaded',timeout:90000});await page.getByText('Action required',{exact:true}).waitFor();await driverForm(page);record('Administrator requests changes and driver resubmits in browser');
 application=(await app('/api/driver-verification',driver.token)).data;assert.equal(application.id,applicationId);
await adminPage.reload({waitUntil:'domcontentloaded',timeout:90000});await adminPage.getByRole('button',{name:'Approve',exact:true}).waitFor();
 assert.equal(await adminPage.getByRole('button',{name:'Approve',exact:true}).isDisabled(),true);
 assert.equal((await app('/api/admin/driver-verifications',admin.token,{action:'review',id:applicationId,submittedAt:application.submitted_at,status:'approved'})).status,400);record('Administrator cannot approve without confirming licence expiry');
 await adminPage.getByLabel('Licence expiry date confirmed from document').fill('2099-12-31');await adminPage.getByRole('button',{name:'Approve',exact:true}).click();await adminPage.getByText('Application approved.',{exact:true}).waitFor();await adminPage.getByRole('tab',{name:'All applications',exact:true}).click();await adminPage.getByLabel('Reason for revoking approval').waitFor();
 await page.reload({waitUntil:'domcontentloaded',timeout:90000});await page.getByText('Approved',{exact:true}).waitFor();await page.screenshot({path:resolve(directory,'driver-approved.png'),fullPage:true});
 assert.ok((await app('/api/carpool',driver.token,listing)).ok);record('Expiry-confirmed approval unlocks ride creation');
 await adminPage.getByLabel('Reason for revoking approval').fill('AUTOMATED TEST: revoke');await adminPage.getByRole('button',{name:'Revoke approval and request new documents',exact:true}).click();await adminPage.getByText('Application action required.',{exact:true}).waitFor();
 assert.equal((await app('/api/carpool',driver.token,listing)).status,403);record('Revoked approval immediately blocks new rides');
 const expiredUpdate=await request('/rest/v1/driver_verifications?id=eq.'+applicationId,{server:true,method:'PATCH',body:{status:'approved',licence_expiry_date:'2000-01-01',retention_until:'2000-01-01T00:00:00Z'}});assert.ok(expiredUpdate.ok,'Set fixture expiry: '+expiredUpdate.status);
 const expiredState=await request('/rest/v1/driver_verifications?select=status,licence_expiry_date&id=eq.'+applicationId,{server:true});assert.equal(expiredState.data[0].licence_expiry_date,'2000-01-01');
 const validity=await request('/rest/v1/rpc/humsafar_driver_approval_valid',{server:true,method:'POST',body:{p_user_id:driver.id}});assert.equal(validity.data,false,'Database helper rejects expired fixture');
 assert.equal((await app('/api/driver-verification',driver.token)).data.status,'action_required');assert.equal((await app('/api/carpool',driver.token,listing)).status,403);record('Expired approval cannot publish rides');
 assert.ok((await app('/api/admin/driver-verifications',admin.token,{action:'purge',id:applicationId})).ok);record('Retention purge deletes test documents and clears references');
 await adminPage.screenshot({path:resolve(directory,'admin-review.png'),fullPage:true});
 writeFileSync(resolve(directory,'live-report.json'),JSON.stringify({passed:checks.length,checks},null,2));
 console.log(`Live verification workflow passed ${checks.length} checks.`);
}catch(error){
 for(const [index,context] of (browser?.contexts()||[]).entries())for(const page of context.pages())await page.screenshot({path:resolve(directory,`failure-${index}.png`),fullPage:true,timeout:10000}).catch(()=>{});
 throw error;
}finally{
 await browser?.close();await cleanup();console.log('Temporary Supabase test accounts, documents and rides removed.');
}
