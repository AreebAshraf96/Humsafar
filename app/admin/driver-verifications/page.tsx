'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, ShieldCheck } from 'lucide-react';
import { validSession } from '@/lib/supabase-auth';
import Link from 'next/link';

type ReviewHistory = { status: string; reason: string | null; reviewed_at: string };
type Application = {
  id: string; user_id: string; driver_name: string; licence_url: string | null; selfie_url: string | null;
  vehicle_registration_number: string | null; status: string; review_reason: string | null; submitted_at: string;
  reviewed_at: string | null; retention_until: string | null; history: ReviewHistory[];
  licence_expiry_date: string | null;
  automated_result: {
    state?: string; reasonCode?: string; expiryConfidence?: number | null;
    faceMatchStatus?: string | null; faceMatchScore?: number | null;
  } | null;
};

const label: Record<string, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', action_required: 'Action required' };

export default function AdminDriverVerificationsPage() {
  const [applications, setApplications] = useState<Application[]>([]);
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
    setLoading(true);
    setError('');
    try {
      const data = await api(undefined, undefined, `?limit=50&offset=${offset}`);
      const page = data.applications || [];
      setApplications(current => offset > 0 ? [...current, ...page] : page);
      setHasMore(page.length === 50);
    }
    catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => { setNow(Date.now()); void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function review(application: Application, status: 'approved' | 'rejected' | 'action_required') {
    setBusy(application.id); setError(''); setNotice('');
    try {
      await api('review', { id: application.id, status, reason: reasons[application.id] || '' });
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
      <div className="verification-title"><span><ShieldCheck size={23}/></span><div><p className="eyebrow">ADMIN REVIEW</p><h1>Driver applications</h1></div><button className="outline" onClick={()=>void load()} disabled={loading}><RefreshCw size={16}/>Refresh</button></div>
      <p className="verification-intro">Review the automated expiry-date and face-match checks alongside the documents. Clear passes may already be approved; uncertain or unavailable checks remain in this queue. Signed image links expire after 30 minutes.</p>
      {error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="banner" role="status">{notice}</p>}
      {loading && applications.length===0 ? <p className="muted">Loading applications…</p> : applications.length === 0 ? <p className="emptycard">There are no verification applications yet.</p> : <div className="admin-verification-list">
        {applications.map(application => {
          const canPurge = now > 0 && !!application.retention_until && new Date(application.retention_until).getTime() <= now && ['approved','rejected'].includes(application.status);
          return <article className="admin-verification-item" key={application.id}>
            <header><div><h2>{application.driver_name}</h2><p className="muted">Application {application.id.slice(0,8)} · Submitted {new Date(application.submitted_at).toLocaleString('en-PK')}</p></div><span className={`verification-pill status-${application.status}`}>{label[application.status]||application.status}</span></header>
            <p><strong>Vehicle registration:</strong> {application.vehicle_registration_number || 'Deleted under the retention policy'}</p>
            <div className="banner" aria-label="Automated verification result">
              <strong>Automated checks: {application.automated_result?.state?.replaceAll('_', ' ') || 'not run'}</strong>
              <p>Licence expiry: {application.licence_expiry_date ? new Date(`${application.licence_expiry_date}T00:00:00`).toLocaleDateString('en-PK') : 'not read'}</p>
              <p>Face comparison: {application.automated_result?.faceMatchStatus || 'not available'}{typeof application.automated_result?.faceMatchScore === 'number' ? ` · ${application.automated_result.faceMatchScore.toFixed(1)}%` : ''}</p>
              {application.automated_result?.reasonCode && application.automated_result.reasonCode !== 'all_checks_passed' && <small>Review reason: {application.automated_result.reasonCode.replaceAll('_', ' ')}</small>}
            </div>
            <div className="admin-verification-images">
              {application.licence_url ? <figure><a href={application.licence_url} target="_blank" rel="noreferrer"><img src={application.licence_url} alt="Submitted driving licence"/></a><figcaption>Driving licence · signed private link</figcaption></figure> : <p className="muted">Licence image was purged.</p>}
              {application.selfie_url ? <figure><a href={application.selfie_url} target="_blank" rel="noreferrer"><img src={application.selfie_url} alt="Submitted selfie"/></a><figcaption>Selfie · signed private link</figcaption></figure> : <p className="muted">Selfie was purged.</p>}
            </div>
            {application.review_reason && <p className="banner"><strong>Latest reason:</strong> {application.review_reason}</p>}
            {!!application.history?.length && <details><summary>Previous decisions ({application.history.length})</summary><ul>{application.history.map((entry,index)=><li key={`${entry.reviewed_at}-${index}`}>{label[entry.status]||entry.status} · {new Date(entry.reviewed_at).toLocaleString('en-PK')}{entry.reason?` · ${entry.reason}`:''}</li>)}</ul></details>}
            {application.status === 'pending' && <div className="admin-review-actions"><label className="field">Reason (required for reject or request changes)<textarea maxLength={1000} value={reasons[application.id]||''} onChange={e=>setReasons({...reasons,[application.id]:e.target.value})} placeholder="Explain what needs correction or why the application is rejected."/></label><div className="actions"><button className="primary" disabled={!!busy} onClick={()=>review(application,'approved')}>{busy===application.id?'Saving…':'Approve'}</button><button className="outline" disabled={!!busy||!reasons[application.id]?.trim()} onClick={()=>review(application,'action_required')}>Request changes</button><button className="outline" disabled={!!busy||!reasons[application.id]?.trim()} onClick={()=>review(application,'rejected')}>Reject</button></div></div>}
            {canPurge && <button className="subtle" disabled={!!busy} onClick={()=>purge(application)}>Delete documents (90-day retention elapsed)</button>}
          </article>;
        })}
      </div>}
      {!loading&&hasMore&&<button className="outline" onClick={()=>void load(applications.length)}>Load more applications</button>}
    </section>
  </main>;
}
