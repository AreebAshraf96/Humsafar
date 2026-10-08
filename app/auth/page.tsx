'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CarFront, CheckCircle2, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { authRequest, saveSession, validSession } from '@/lib/supabase-auth';
import { disableNotifications } from '@/lib/notification-subscriptions';
import type { SupabaseSession } from '@/lib/supabase-auth';

type Mode = 'login' | 'signup' | 'recover' | 'update';
function destination() {
  const next = sessionStorage.getItem('humsafar.returnTo');
  sessionStorage.removeItem('humsafar.returnTo');
  return next === '/' || next?.startsWith('/#trip=') ? next : '/';
}

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(location.search).has('logout')) {
      void (async () => {
        await Promise.resolve();
        setBusy(true);
        try {
          const session = await validSession();
          const results = await Promise.allSettled([
            disableNotifications(),
            session ? authRequest('logout', {}, session.access_token) : Promise.resolve(),
          ]);
          if (results.some(result => result.status === 'rejected')) throw new Error('Cleanup incomplete');
          setNotice('You have signed out.');
        } catch { setError('Signed out locally. If notification cleanup failed, disable this site’s notifications in your browser settings.'); }
        finally { saveSession(null); setBusy(false); history.replaceState(null, '', '/auth'); }
      })();
      return;
    }
    const hash = new URLSearchParams(location.hash.slice(1));
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    const type = hash.get('type');
    if (!accessToken || !refreshToken) return;
    authRequest('user', undefined, accessToken).then((user) => {
      const session: SupabaseSession = { access_token: accessToken, refresh_token: refreshToken, user: user as SupabaseSession['user'], expires_at: Number(hash.get('expires_at')) || Math.floor(Date.now()/1000) + Number(hash.get('expires_in') || 3600) };
      saveSession(session);
      history.replaceState(null, '', location.pathname + location.search);
      if (type === 'recovery') setMode('update');
      else if (user.email_confirmed_at) {
  setNotice('Email verified successfully. Your account is ready. Login to continue to Humsafar.'); setMode('login');
}else setNotice('Link confirmed. You can now sign in.');
    }).catch((e) => setError(e.message));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    try {
      if (mode === 'signup') {
        await authRequest(`signup?redirect_to=${encodeURIComponent(`${location.origin}/auth`)}`, { email: email.trim(), password });
        setNotice('Check your inbox for a verification link. Your account is ready after you confirm your email.');
      } else if (mode === 'recover') {
        await authRequest(`recover?redirect_to=${encodeURIComponent(`${location.origin}/auth`)}`, { email: email.trim() });
        setNotice('If an account exists for that email, a password reset link is on its way.');
      } else if (mode === 'update') {
        const session = JSON.parse(localStorage.getItem('humsafar.supabase.session') || 'null') as SupabaseSession | null;
        if (!session) throw new Error('Open the password reset link from your email first.');
        await authRequest('user', { password }, session.access_token, 'PUT');
        setNotice('Password updated. You can now continue to Humsafar.');
        setTimeout(() => location.assign(destination()), 900);
      } else {
        const session = await authRequest<SupabaseSession>('token?grant_type=password', { email: email.trim(), password });
        if (!session.user.email_confirmed_at) { saveSession(null); throw new Error('Please verify your email using the link we sent before signing in.'); }
        await disableNotifications();
        saveSession(session); location.assign(destination());
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not complete that request.'); }
    finally { setBusy(false); }
  }

  const title = mode === 'signup' ? 'Join the journey' : mode === 'recover' ? 'Reset your password' : mode === 'update' ? 'Choose a new password' : 'Welcome back';
  const description = mode === 'signup' ? 'Create an account to find and share rides in Karachi.' : mode === 'recover' ? 'We’ll email you a secure password reset link.' : mode === 'update' ? 'Use a strong password you have not used before.' : 'Sign in to pick up where your next journey begins.';

  return <main className="auth-page">
    {process.env.NEXT_PUBLIC_PREVIEW_MODE==='true'&&<div className="preview-banner" style={{gridColumn:'1 / -1'}}>Review demo · Connected to your Supabase login · Ride changes stay local</div>}
    <section className="auth-aside"><a className="brand" href="/auth"><span className="brand-icon"><CarFront size={24}/></span>humsafar</a><div className="auth-story"><p className="eyebrow">KARACHI, TOGETHER</p><h1>Your city.<br/>Your people.<br/>Your next ride.</h1><p>Find a seat, share the journey, and travel with people going your way.</p><div className="auth-promise"><ShieldCheck size={19}/> Sign in to browse rides and meet your fellow travellers.</div></div><span className="auth-aside-foot">Humsafar · Karachi carpool pilot</span></section>
    <section className="auth-main"><div className="auth-card">
      <p className="eyebrow">YOUR HUMSAFAR ACCOUNT</p><h2>{title}</h2><p className="auth-description">{description}</p>
      <form onSubmit={submit}>
        {mode !== 'update' && <label className="field">Email address<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"/></label>}
        {mode !== 'recover' && <label className="field">{mode === 'update' ? 'New password' : 'Password'}<span className="auth-password"><input type={showPassword ? 'text' : 'password'} name="password" autoComplete={mode === 'signup' || mode === 'update' ? 'new-password' : 'current-password'} required minLength={mode === 'update' ? 8 : 8} placeholder="At least 8 characters"/><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></span></label>}
        {mode === 'login' && <button className="auth-forgot" type="button" onClick={() => {setMode('recover');setError('');setNotice('');}}>Forgot password?</button>}
        {error && <div className="banner error" role="alert">{error}</div>}
        {notice && <div className="auth-notice" role="status"><CheckCircle2 size={19}/><span>{notice}</span></div>}
        <button className="primary auth-submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'recover' ? 'Send reset link' : mode === 'update' ? 'Update password' : 'Sign in'}</button>
      </form>
      {mode !== 'update' && <p className="auth-switch">{mode === 'signup' ? 'Already have an account?' : mode === 'login' ? 'New to Humsafar?' : 'Remembered your password?'} <button type="button" onClick={() => {setMode(mode === 'signup' || mode === 'recover' ? 'login' : 'signup');setError('');setNotice('');}}>{mode === 'signup' || mode === 'recover' ? 'Sign in' : 'Create an account'}</button></p>}
      <p className="auth-privacy">We use your email only to secure your account and help you use Humsafar.</p>
    </div></section>
  </main>;
}
