'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, CheckCircle2, FileCheck2, ShieldCheck } from 'lucide-react';
import { supabaseConfig, validSession } from '@/lib/supabase-auth';
import Link from 'next/link';
import PhotoInput from './photo-input';
import VerificationNav from '../verification-nav';
import type { AutomatedVerification } from '@/lib/driver-verification-automation';

type Application = {
  automation_available?: boolean; id?: string; status: 'not_submitted' | 'pending' | 'approved' | 'rejected' | 'action_required';
  vehicle_registration_number?: string; review_reason?: string | null; submitted_at?: string; reviewed_at?: string | null;
  automated_result?: AutomatedVerification;
};

const statusLabels: Record<Application['status'], string> = {
  not_submitted: 'Not submitted', pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', action_required: 'Action required',
};

export default function DriverVerificationPage() {
  const [application, setApplication] = useState<Application>({ status: 'not_submitted' });
  const [registration, setRegistration] = useState('');
  const [declaredName,setDeclaredName]=useState('');
  const [retaking,setRetaking]=useState(false);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [licenceFile,setLicenceFile]=useState<File|null>(null);
  const [selfieFile,setSelfieFile]=useState<File|null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const session = await validSession();
          if (!session) { location.replace('/auth'); return; }
          const response = await fetch('/api/driver-verification', { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store' });
          const data = await response.json() as Application & { error?: string };
          if (response.status === 401) { location.replace('/auth'); return; }
          if (!response.ok) throw new Error(data.error || 'Could not load verification status.');
          setApplication(data);
          if (data.vehicle_registration_number) setRegistration(data.vehicle_registration_number);
        } catch (error) { setError((error as Error).message); }
        finally { setLoading(false); }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage('');
    const form = event.currentTarget;
    const formData = new FormData(form);
    if(retaking ? !licenceFile&&!selfieFile : !licenceFile||!selfieFile){setError(retaking?'Take or choose at least one replacement photo.':'Select a licence image and a selfie before submitting.');return;}
    setBusy(true);
    const uploadedPaths: string[] = [];
    try {
      const session = await validSession();
      if (!session) { location.replace('/auth'); return; }
      if (!consent) throw new Error('Confirm consent before submitting.');
      const send = async (body: BodyInit): Promise<Record<string, unknown>> => {
        const response = await fetch('/api/driver-verification', {
          method: 'POST', headers: {
            Authorization: `Bearer ${session.access_token}`,
            ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          }, body,
        });
        const text = await response.text();
        let data: Record<string, unknown> = {};
        try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; }
        catch { data = { error: response.status === 413 ? 'The upload request is too large. Try an image under 5 MB.' : text || 'The server returned an unreadable response.' }; }
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not submit your application.');
        return data;
      };
      const { url, anonKey } = supabaseConfig();
      const upload = async (field: 'licence' | 'selfie', file: File) => {
        const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
        const path = `${session.user.id}/${crypto.randomUUID()}/${field}.${extension}`;
        const response = await fetch(`${url}/storage/v1/object/driver-verification/${path.split('/').map(encodeURIComponent).join('/')}`, {
          method: 'POST',
          headers: {
            apikey: anonKey, Authorization: `Bearer ${session.access_token}`,
            'Content-Type': file.type, 'x-upsert': 'false',
          },
          body: file,
        });
        const text = await response.text();
        if (!response.ok) {
          let reason = text;
          try { reason = (JSON.parse(text) as { message?: string; error?: string }).message || (JSON.parse(text) as { error?: string }).error || text; } catch { /* Keep the response text. */ }
          throw new Error(reason || `Could not upload the ${field === 'licence' ? 'licence' : 'selfie'} image.`);
        }
        uploadedPaths.push(path);
        return path;
      };

      // Upload photos directly to Storage so large file bodies bypass the app
      // runtime's smaller request-body limit. The bucket and RLS policies still
      // enforce the per-file size, MIME type, and ownership.
      const paths:{licencePath?:string;selfiePath?:string}={};
      if(licenceFile)paths.licencePath=await upload('licence',licenceFile);
      if(selfieFile)paths.selfiePath=await upload('selfie',selfieFile);
      const data = await send(JSON.stringify({
        action: 'submit', ...paths, ...(retaking?{replaceSubmittedAt:application.submitted_at}:{}), registration, declaredName: String(formData.get('declaredName')||''),
      }));
      const submittedApplication = data as unknown as Application;
      setApplication(submittedApplication);
      setRetaking(false);
      setMessage('Your documents were submitted. An administrator will check the licence and face comparison before deciding.');
      setLicenceFile(null);setSelfieFile(null);
      form.reset(); setConsent(false);
    } catch (error) {
      setError((error as Error).message);
      if (uploadedPaths.length) {
        try {
          const session = await validSession();
          if (session) await fetch('/api/driver-verification', {
            method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cleanup', paths: uploadedPaths }),
          });
        } catch { /* A later cleanup can remove any abandoned upload. */ }
      }
    }
    finally { setBusy(false); }
  }

  async function retryAutomation() {
    setBusy(true); setError(''); setMessage('');
    try {
      if(declaredName.trim().length<2)throw new Error('Enter your full name as printed on the licence before running checks.');
      const session = await validSession();
      if (!session) { location.replace('/auth'); return; }
      const response = await fetch('/api/driver-verification', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_automation',declaredName:declaredName.trim() }),
      });
      const text = await response.text();
      let data: Record<string, unknown> = {};
      try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; }
      catch { data = { error: text || 'The server returned an unreadable response.' }; }
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not retry automated checks.');
      const updated = data as unknown as Application;
      setApplication(current => ({ ...current, ...updated }));
      setMessage(updated.automated_result?.state === 'unavailable' ? 'Face comparison is temporarily unavailable. Your application remains queued for manual review.' : updated.status === 'pending' ? 'The face comparison ran again. Your application remains pending for administrator review.' : 'Your application status has been updated.');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  const checks=application.automated_result?.documentChecks;
  const needsClearerPhoto=checks?.state==='review_required'&&(['unreadable','ambiguous'].includes(checks.expiryStatus)||checks.nameStatus==='unreadable'||!checks.licenceNumberPresent||checks.reasons.some(reason=>/blurry|too small|too dark|overexposed/i.test(reason)));
  const canSubmit = ['not_submitted','rejected','action_required'].includes(application.status)||(application.status==='pending'&&retaking);
  return <main className="verification-shell">
    <Link className="verification-back" href="/"><ArrowLeft size={17}/> Back to Humsafar</Link>
    <section className="verification-card">
      <VerificationNav/>
      <div className="verification-title"><span><ShieldCheck size={23}/></span><div><p className="eyebrow">DRIVER SAFETY</p><h1>Driver verification</h1></div></div>
      <p className="verification-intro">Take photos or choose existing images. Automatic checks read licence details, compare the supplied name, check expiry and photo quality, and provide reasons for anything that needs attention. An administrator confirms the documents before approving driving access.</p>
      <div className={`verification-status status-${application.status}`} role="status"><FileCheck2 size={20}/><div><strong>{statusLabels[application.status]}</strong>{application.submitted_at && <small>Submitted {new Date(application.submitted_at).toLocaleString('en-PK')}</small>}</div></div>
      {application.automated_result && application.automated_result.state !== 'not_run' && <div className="banner" role="status">
        <strong>{application.automated_result.state === 'unavailable' ? 'Automated face check unavailable' : 'Face comparison result'}</strong>
        {application.automated_result.faceMatchStatus && <p>Selfie and licence photo: {application.automated_result.faceMatchStatus.replaceAll('_', ' ')}{typeof application.automated_result.faceMatchScore === 'number' ? ` · cosine similarity ${application.automated_result.faceMatchScore.toFixed(3)}` : ''}.</p>}
        {application.automated_result.reasonCode && <p>Reason: {application.automated_result.reasonCode.replaceAll('_', ' ')}.</p>}
        <p>An administrator must review the licence expiry and details before approval.</p>
      </div>}
      {application.automated_result?.documentChecks&&<div className="banner"><strong>Automatic document checks</strong><ul>{application.automated_result.documentChecks.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul><p>Expiry read from document: {application.automated_result.documentChecks.expiryDate||'Could not read confidently'}</p><p>Final driver approval requires administrator review.</p></div>}
      {application.status==='pending'&&needsClearerPhoto&&!retaking&&<div className="banner error" role="alert"><strong>Please take another clear photo</strong><p>Some licence details could not be read confidently. Show the whole licence, including the expiry date, in good light without glare. Replace only the unclear photo; your other photo will be kept.</p><button type="button" className="primary" onClick={()=>{setRetaking(true);setError('');setMessage('')}}>Retake / replace photos</button><p>Your request remains pending. You can also wait for administrator review.</p></div>}
      {application.review_reason && <div className="banner error" role="alert"><strong>Reviewer feedback</strong><p>{application.review_reason}</p>{application.reviewed_at && <small>Reviewed {new Date(application.reviewed_at).toLocaleString('en-PK')}</small>}</div>}
      {application.status === 'approved' && <div className="banner verification-approved"><CheckCircle2 size={18}/> Your driver profile is approved. You can publish rides now.</div>}
      {loading ? <p className="muted">Loading your status…</p> : canSubmit ? <form className="verification-form" onSubmit={submit}>
        {retaking&&<div className="banner"><strong>Replace unclear photos</strong><p>Take or choose a new licence photo, selfie, or both. Any photo you leave unchanged will be kept.</p><button type="button" className="subtle" onClick={()=>{setRetaking(false);setLicenceFile(null);setSelfieFile(null);setError('')}}>Cancel replacement</button></div>}
        <div className="formgrid">
          <PhotoInput id="licence-image" label="Driving licence image" facing="environment" file={licenceFile} onChange={setLicenceFile}/>
          <PhotoInput id="selfie-image" label="Selfie" facing="user" file={selfieFile} onChange={setSelfieFile}/>
          <label className="field span2">Full name as printed on licence<input name="declaredName" value={declaredName} onChange={event=>setDeclaredName(event.target.value)} autoComplete="name" required minLength={2} maxLength={100}/><small>Used to compare the printed text with the name you provide. This does not verify identity.</small></label>
          <label className="field span2">Vehicle registration number<input name="vehicleRegistration" required minLength={3} maxLength={20} pattern="[A-Za-z0-9 -]{3,20}" value={registration} onChange={e=>setRegistration(e.target.value.toUpperCase())} placeholder="e.g. ABC-123"/><small>Use the registration number of the vehicle you intend to drive.</small></label>
        </div>
        <label className="verification-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> I consent to Humsafar securely storing my documents and processing them on its self-hosted service to read licence details, check expiry and image quality, and compare the submitted photos. An administrator will check the licence expiry and details before deciding. This is not official government authentication.</label>
        {error && <p className="banner error" role="alert">{error}</p>}{message && <p className="banner" role="status">{message}</p>}
        <button className="primary" disabled={busy||!consent}>{busy?'Uploading securely…':retaking?'Submit replacement photos':application.status==='not_submitted'?'Submit for review':'Resubmit for review'}</button>
      </form> : application.status === 'pending' ? <>
        <p className="muted">Your application is in the review queue. You can replace unclear photos while it is pending.</p>
        {!needsClearerPhoto&&<button type="button" className="outline" onClick={()=>{setRetaking(true);setError('');setMessage('')}}>Replace photos</button>}
        {application.automation_available && (application.automated_result?.state === 'unavailable'||!application.automated_result?.documentChecks||application.automated_result?.documentChecks?.state === 'unavailable') && <><label className="field">Full name as printed on licence<input value={declaredName} onChange={event=>setDeclaredName(event.target.value)} autoComplete="name" maxLength={100}/></label><button type="button" className="primary" disabled={busy} onClick={retryAutomation}>{busy ? 'Running automatic checks…' : 'Run automatic checks'}</button></>}
        {error && <p className="banner error" role="alert">{error}</p>}{message && <p className="banner" role="status">{message}</p>}
      </> : null}
      <p className="verification-retention">Privacy: documents stay in private storage, are available only to you and authorized reviewers, and are eligible for deletion 90 days after approval or rejection. You can contact Humsafar to request earlier deletion.</p>
    </section>
  </main>;
}
