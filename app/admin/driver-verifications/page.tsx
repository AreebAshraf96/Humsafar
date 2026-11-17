'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw, ShieldCheck } from 'lucide-react';
import { validSession } from '@/lib/supabase-auth';
import Link from 'next/link';
import Image from 'next/image';
import VerificationNav from '../../verification-nav';
import type { DocumentChecks } from '@/lib/driver-verification-automation';

type ReviewHistory = { status: string; reason: string | null; reviewed_at: string };
type Application = {
  id: string; user_id: string; driver_name: string; licence_url: string | null; selfie_url: string | null;
  vehicle_registration_number: string | null; status: string; review_reason: string | null; submitted_at: string;
  licence_expiry_date: string | null; reviewed_at: string | null; retention_until: string | null; history: ReviewHistory[];
  automated_result: {
    state?: string; reasonCode?: string; documentChecks?: DocumentChecks;
    faceMatchStatus?: string | null; faceMatchScore?: number | null;
  } | null;
};

const label: Record<string, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', action_required: 'Action required' };

export default function AdminDriverVerificationsPage() {
  const loadVersion=useRef(0);
  const submissionVersions=useRef<Record<string,string>>({});
  const [filter,setFilter]=useState<'pending'|'all'>('pending');
  const [lastUpdated,setLastUpdated]=useState<number|null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [expiryDates, setExpiryDates] = useState<Record<string,string>>({});
  const [reasons, setReasons] = useState<Record<string,string>>({});
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(0);

  const api = useCallback(async (action?: string, payload?: Record<string, unknown>, query = ''): Promise<{ applications?: Application[]; error?: string; [key: string]: unknown }> => {
    const session = await validSession();
    if (!session) { location.replace('/auth'); throw new Error('Sign in to continue.'); }
    const response = await fetch('/api/admin/driver-verifications'+query, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${session.access_token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      body: payload ? JSON.stringify({ action, ...payload }) : undefined,
      cache: 'no-store',
    });
    const data = await response.json() as { applications?: Application[]; error?: string; [key: string]: unknown };
    if (!response.ok) throw new Error(data.error || 'Could not complete the administrator request.');
    return data;
  }, []);

  const load = useCallback(async (offset = 0) => {
    const version=++loadVersion.current;
    setLoading(true);
    setError('');
    try {
      const data = await api(undefined, undefined, `?limit=50&offset=${offset}${filter==='pending'?'&status=pending':''}`);
      if(version!==loadVersion.current)return;
      const page = data.applications || [];
      const changed=page.filter(application=>submissionVersions.current[application.id]&&submissionVersions.current[application.id]!==application.submitted_at).map(application=>application.id);
      if(changed.length){setExpiryDates(current=>{const next={...current};changed.forEach(id=>delete next[id]);return next});setReasons(current=>{const next={...current};changed.forEach(id=>delete next[id]);return next});setNotice('An applicant replaced their photos. Inspect the new photos and confirm the expiry again.');}
      page.forEach(application=>{submissionVersions.current[application.id]=application.submitted_at});
      setApplications(current => offset > 0 ? [...current, ...page] : page);
      setHasMore(page.length === 50);setLastUpdated(Date.now());
    }
    catch (error) { if(version===loadVersion.current)setError((error as Error).message); }
    finally { if(version===loadVersion.current)setLoading(false); }
  }, [api,filter]);
  useEffect(() => {
    const timer = setTimeout(() => { setNow(Date.now()); void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(()=>{
    if(filter!=='pending'||busy)return;
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void load()},20000);
    return()=>clearInterval(timer);
  },[load,filter,busy]);

  async function review(application: Application, status: 'approved' | 'rejected' | 'action_required') {
    setBusy(application.id); setError(''); setNotice('');
    try {
      await api('review', { id: application.id, status, submittedAt:application.submitted_at, reason: reasons[application.id] || '', licenceExpiryDate: expiryDates[application.id] || application.licence_expiry_date || null });
      setNotice(`Application ${label[status].toLowerCase()}.`); await load();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  }

  async function purge(application: Application) {
    setBusy(application.id); setError(''); setNotice('');
    try { await api('purge', { id: application.id }); setNotice('Expired verification documents deleted.'); await load(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  }

  return <main className="verification-shell">
    <Link className="verification-back" href="/"><ArrowLeft size={17}/> Back to Humsafar</Link>
    <section className="verification-card admin-verification-card">
      <VerificationNav/>
      <div className="verification-title"><span><ShieldCheck size={23}/></span><div><p className="eyebrow">ADMIN REVIEW</p><h1>Driver applications</h1></div><button className="outline" onClick={()=>void load()} disabled={loading}><RefreshCw size={16}/>Refresh</button></div>
      <div className="verification-tabs" role="tablist" aria-label="Request status"><button type="button" role="tab" aria-selected={filter==='pending'} className={filter==='pending'?'primary':'outline'} onClick={()=>setFilter('pending')}>Pending requests</button><button type="button" role="tab" aria-selected={filter==='all'} className={filter==='all'?'primary':'outline'} onClick={()=>setFilter('all')}>All applications</button></div>
      <p className="muted">{lastUpdated?'Updated '+new Date(lastUpdated).toLocaleTimeString('en-PK'):'Loading requests…'}{filter==='pending'?' · Refreshes every 20 seconds while this tab is visible.':''}</p>
      <p className="verification-intro">Use the face comparison as an aid, then inspect the licence image yourself to confirm its expiry and details before approving. No application is approved automatically. Signed image links expire after 30 minutes.</p>
      {error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="banner" role="status">{notice}</p>}
      {loading && applications.length===0 ? <p className="muted">Loading applications…</p> : applications.length === 0 ? <p className="emptycard">{filter==='pending'?'There are no pending verification requests.':'There are no verification applications yet.'}</p> : <div className="admin-verification-list">
        {applications.map(application => {
          const canPurge = now > 0 && !!application.retention_until && new Date(application.retention_until).getTime() <= now && ['approved','rejected'].includes(application.status);
          return <article className="admin-verification-item" key={application.id}>
            <header><div><h2>{application.driver_name}</h2><p className="muted">Application {application.id.slice(0,8)} · Submitted {new Date(application.submitted_at).toLocaleString('en-PK')}</p></div><span className={`verification-pill status-${application.status}`}>{label[application.status]||application.status}</span></header>
            <p><strong>Vehicle registration:</strong> {application.vehicle_registration_number || 'Deleted under the retention policy'}</p>
            <div className="banner" aria-label="Automated verification result">
              <strong>Automated checks: {application.automated_result?.state?.replaceAll('_', ' ') || 'not run'}</strong>
              <p>Face comparison: {application.automated_result?.faceMatchStatus || 'not available'}{typeof application.automated_result?.faceMatchScore === 'number' ? ` · cosine similarity ${application.automated_result.faceMatchScore.toFixed(3)}` : ''}</p>
              {application.automated_result?.reasonCode && <small>Review reason: {application.automated_result.reasonCode.replaceAll('_', ' ')}</small>}
            </div>
            {application.automated_result?.documentChecks&&<div className="banner"><strong>Automatic document checks — reviewer confirmation required</strong><ul>{application.automated_result.documentChecks.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul><p>Detected expiry: {application.automated_result.documentChecks.expiryDate||'Unreadable or ambiguous'}</p>{application.status==='pending'&&application.automated_result.documentChecks.expiryStatus==='valid'&&application.automated_result.documentChecks.expiryDate&&<button type="button" className="outline" onClick={()=>setExpiryDates({...expiryDates,[application.id]:application.automated_result!.documentChecks!.expiryDate!})}>Use detected date after checking document</button>}</div>}
            <div className="admin-verification-images">
              {application.licence_url ? <figure><a href={application.licence_url} target="_blank" rel="noreferrer"><Image unoptimized width={640} height={480} style={{width: '100%', height: 'auto'}} src={application.licence_url} alt="Submitted driving licence"/></a><figcaption>Driving licence · signed private link</figcaption></figure> : <p className="muted">Licence image was purged.</p>}
              {application.selfie_url ? <figure><a href={application.selfie_url} target="_blank" rel="noreferrer"><Image unoptimized width={640} height={480} style={{width: '100%', height: 'auto'}} src={application.selfie_url} alt="Submitted selfie"/></a><figcaption>Selfie · signed private link</figcaption></figure> : <p className="muted">Selfie was purged.</p>}
            </div>
            {application.review_reason && <p className="banner"><strong>Latest reason:</strong> {application.review_reason}</p>}
            {!!application.history?.length && <details><summary>Previous decisions ({application.history.length})</summary><ul>{application.history.map((entry,index)=><li key={`${entry.reviewed_at}-${index}`}>{label[entry.status]||entry.status} · {new Date(entry.reviewed_at).toLocaleString('en-PK')}{entry.reason?` · ${entry.reason}`:''}</li>)}</ul></details>}
            {(application.status === 'pending' || (application.status === 'approved' && !application.licence_expiry_date)) && <div className="admin-review-actions"><label className="field">Licence expiry date confirmed from document<input type="date" value={expiryDates[application.id]||application.licence_expiry_date||''} onChange={e=>setExpiryDates({...expiryDates,[application.id]:e.target.value})}/></label><label className="field">Reason (required for reject or request changes)<textarea maxLength={1000} value={reasons[application.id]||''} onChange={e=>setReasons({...reasons,[application.id]:e.target.value})} placeholder="Explain what needs correction or why the application is rejected."/></label><div className="actions"><button className="primary" disabled={!!busy||!expiryDates[application.id]} onClick={()=>review(application,'approved')}>{busy===application.id?'Saving…':'Approve'}</button><button className="outline" disabled={!!busy||!reasons[application.id]?.trim()} onClick={()=>review(application,'action_required')}>Request changes</button><button className="outline" disabled={!!busy||!reasons[application.id]?.trim()} onClick={()=>review(application,'rejected')}>Reject</button></div></div>}
            {application.status === 'approved' && <div className="admin-review-actions"><p>Licence approval valid through {application.licence_expiry_date || 'expiry confirmation required'} (Pakistan time).</p><label className="field">Reason for revoking approval<textarea maxLength={1000} value={reasons[application.id]||''} onChange={e=>setReasons({...reasons,[application.id]:e.target.value})}/></label><button className="outline" disabled={!!busy||!reasons[application.id]?.trim()} onClick={()=>review(application,'action_required')}>Revoke approval and request new documents</button></div>}
            {canPurge && <button className="subtle" disabled={!!busy} onClick={()=>purge(application)}>Delete documents (90-day retention elapsed)</button>}
          </article>;
        })}
      </div>}
      {!loading&&hasMore&&<button className="outline" onClick={()=>void load(applications.length)}>Load more applications</button>}
    </section>
  </main>;
}
