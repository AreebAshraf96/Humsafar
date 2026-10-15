'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, CheckCircle2, FileCheck2, ShieldCheck } from 'lucide-react';
import { supabaseConfig, validSession } from '@/lib/supabase-auth';
import Link from 'next/link';

type Application = {
  id?: string; status: 'not_submitted' | 'pending' | 'approved' | 'rejected' | 'action_required';
  vehicle_registration_number?: string; review_reason?: string | null; submitted_at?: string; reviewed_at?: string | null;
  licence_expiry_date?: string | null;
  automated_result?: { state?: 'not_run' | 'clear_pass' | 'needs_review' | 'unavailable'; reasonCode?: string; faceMatchStatus?: string | null };
};

const statusLabels: Record<Application['status'], string> = {
  not_submitted: 'Not submitted', pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', action_required: 'Action required',
};

export default function DriverVerificationPage() {
  const [application, setApplication] = useState<Application>({ status: 'not_submitted' });
  const [registration, setRegistration] = useState('');
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const licenceInput = useRef<HTMLInputElement>(null);
  const selfieInput = useRef<HTMLInputElement>(null);
  const licencePreviewUrl = useRef<string | null>(null);
  const selfiePreviewUrl = useRef<string | null>(null);
  const [licencePreview, setLicencePreview] = useState<string | null>(null);
  const [selfiePreview, setSelfiePreview] = useState<string | null>(null);

  useEffect(() => () => {
    if (licencePreviewUrl.current) URL.revokeObjectURL(licencePreviewUrl.current);
    if (selfiePreviewUrl.current) URL.revokeObjectURL(selfiePreviewUrl.current);
  }, []);

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
    const licenceFile = formData.get('licence');
    const selfieFile = formData.get('selfie');
    if (!(licenceFile instanceof File) || !licenceFile.size || !(selfieFile instanceof File) || !selfieFile.size) {
      setError('Select a licence image and a selfie before submitting.'); return;
    }
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
      };

      // Upload photos directly to Storage so large file bodies bypass the app
      // runtime's smaller request-body limit. The bucket and RLS policies still
      // enforce the per-file size, MIME type, and ownership.
      await upload('licence', licenceFile);
      await upload('selfie', selfieFile);
      const data = await send(JSON.stringify({
        action: 'submit', licencePath: uploadedPaths[0], selfiePath: uploadedPaths[1], registration,
      }));
      const application = data as unknown as Application;
      setApplication(application);
      setMessage(application.status === 'approved'
        ? 'Automated checks passed. Your driver verification is approved.'
        : 'Your documents were submitted. An administrator will review the results.');
      if (licencePreviewUrl.current) URL.revokeObjectURL(licencePreviewUrl.current); licencePreviewUrl.current = null; setLicencePreview(null);
      if (selfiePreviewUrl.current) URL.revokeObjectURL(selfiePreviewUrl.current); selfiePreviewUrl.current = null; setSelfiePreview(null);
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

  const canSubmit = ['not_submitted','rejected','action_required'].includes(application.status);
  return <main className="verification-shell">
    <Link className="verification-back" href="/"><ArrowLeft size={17}/> Back to Humsafar</Link>
    <section className="verification-card">
      <div className="verification-title"><span><ShieldCheck size={23}/></span><div><p className="eyebrow">DRIVER SAFETY</p><h1>Driver verification</h1></div></div>
      <p className="verification-intro">Submit a licence image, a selfie, and your vehicle registration number. Humsafar’s self-hosted verification service checks the licence expiry date and compares the two faces. Clear passes can be approved automatically; uncertain results go to an administrator.</p>
      <div className={`verification-status status-${application.status}`} role="status"><FileCheck2 size={20}/><div><strong>{statusLabels[application.status]}</strong>{application.submitted_at && <small>Submitted {new Date(application.submitted_at).toLocaleString('en-PK')}</small>}</div></div>
      {application.automated_result && application.automated_result.state !== 'not_run' && <div className="banner" role="status">
        <strong>{application.automated_result.state === 'clear_pass' ? 'Automated checks passed' : application.automated_result.state === 'unavailable' ? 'Automated checks unavailable' : 'Admin review required'}</strong>
        {application.licence_expiry_date && <p>Licence expiry date read: {new Date(`${application.licence_expiry_date}T00:00:00`).toLocaleDateString('en-PK')}.</p>}
        {application.automated_result.state !== 'clear_pass' && <p>We could not confirm every check automatically. Your application will be reviewed by an administrator.</p>}
      </div>}
      {application.review_reason && <div className="banner error" role="alert"><strong>Reviewer feedback</strong><p>{application.review_reason}</p>{application.reviewed_at && <small>Reviewed {new Date(application.reviewed_at).toLocaleString('en-PK')}</small>}</div>}
      {application.status === 'approved' && <div className="banner verification-approved"><CheckCircle2 size={18}/> Your driver profile is approved. You can publish rides now.</div>}
      {loading ? <p className="muted">Loading your status…</p> : canSubmit ? <form className="verification-form" onSubmit={submit}>
        <div className="formgrid">
          <div className="field"><label htmlFor="licence-image">Driving licence image</label><input ref={licenceInput} id="licence-image" name="licence" type="file" accept="image/jpeg,image/png,image/webp" required capture="environment" onChange={e=>{const file=e.currentTarget.files?.[0]||null;if(file&&(file.size>5*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type))){e.currentTarget.value='';setError('Choose a JPG, PNG, or WebP image up to 5 MB.');return}setError('');if(licencePreviewUrl.current)URL.revokeObjectURL(licencePreviewUrl.current);licencePreviewUrl.current=file?URL.createObjectURL(file):null;setLicencePreview(licencePreviewUrl.current)}}/><small>Clear, readable JPG, PNG, or WebP image. Maximum 5 MB.</small>{licencePreview&&<><img className="verification-image-preview" src={licencePreview} alt="Driving licence preview"/><button type="button" className="subtle" onClick={()=>{if(licenceInput.current)licenceInput.current.value='';if(licencePreviewUrl.current)URL.revokeObjectURL(licencePreviewUrl.current);licencePreviewUrl.current=null;setLicencePreview(null)}}>Remove / choose another</button></>}</div>
          <div className="field"><label htmlFor="selfie-image">Selfie</label><input ref={selfieInput} id="selfie-image" name="selfie" type="file" accept="image/jpeg,image/png,image/webp" required capture="user" onChange={e=>{const file=e.currentTarget.files?.[0]||null;if(file&&(file.size>5*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type))){e.currentTarget.value='';setError('Choose a JPG, PNG, or WebP image up to 5 MB.');return}setError('');if(selfiePreviewUrl.current)URL.revokeObjectURL(selfiePreviewUrl.current);selfiePreviewUrl.current=file?URL.createObjectURL(file):null;setSelfiePreview(selfiePreviewUrl.current)}}/><small>Face visible, good lighting. Maximum 5 MB.</small>{selfiePreview&&<><img className="verification-image-preview" src={selfiePreview} alt="Selfie preview"/><button type="button" className="subtle" onClick={()=>{if(selfieInput.current)selfieInput.current.value='';if(selfiePreviewUrl.current)URL.revokeObjectURL(selfiePreviewUrl.current);selfiePreviewUrl.current=null;setSelfiePreview(null)}}>Remove / retake</button></>}</div>
          <label className="field span2">Vehicle registration number<input name="vehicleRegistration" required minLength={3} maxLength={20} pattern="[A-Za-z0-9 -]{3,20}" value={registration} onChange={e=>setRegistration(e.target.value.toUpperCase())} placeholder="e.g. ABC-123"/><small>Use the registration number of the vehicle you intend to drive.</small></label>
        </div>
        <label className="verification-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> I consent to Humsafar securely storing my documents and processing them with its self-hosted service to read the licence expiry date and compare my selfie with the licence photo. Clear checks may be approved automatically; uncertain results go to an administrator. This is not official government authentication.</label>
        {error && <p className="banner error" role="alert">{error}</p>}{message && <p className="banner" role="status">{message}</p>}
        <button className="primary" disabled={busy||!consent}>{busy?'Uploading securely…':application.status==='not_submitted'?'Submit for review':'Resubmit for review'}</button>
      </form> : application.status === 'pending' ? <p className="muted">Your application is in the review queue. You cannot submit another application while review is pending.</p> : null}
      <p className="verification-retention">Privacy: documents stay in private storage, are available only to you and authorized reviewers, and are eligible for deletion 90 days after approval or rejection. You can contact Humsafar to request earlier deletion.</p>
    </section>
  </main>;
}
