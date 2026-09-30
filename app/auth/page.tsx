'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CarFront, CheckCircle2, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { authRequest, getStoredSession, saveSession } from '@/lib/supabase-auth';
import type { SupabaseSession } from '@/lib/supabase-auth';

type Mode = 'login' | 'signup' | 'recover' | 'update';

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(location.search).has('logout')) {
      const session = getStoredSession();
      if (session) void authRequest('logout', {}, session.access_token).catch(() => undefined).finally(() => saveSession(null));
      else saveSession(null);
      history.replaceState(null, '', '/auth');
    }
    const hash = new URLSearchParams(location.hash.slice(1));
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    const type = hash.get('type');
    if (!accessToken || !refreshToken) return;
    authRequest('user', undefined, accessToken).then((user) => {
      const session: SupabaseSession = { access_token: accessToken, refresh_token: refreshToken, user, expires_at: Number(hash.get('expires_at')) || undefined };
      saveSession(session);
      history.replaceState(null, '', location.pathname);
      if (type === 'recovery') setMode('update');
      else if (user.email_confirmed_at) { setNotice('Your email is verified. You are signed in.'); setTimeout(() => location.assign('/'), 800); }
      else setNotice('Link confirmed. You can now sign in.');
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
        setTimeout(() => location.assign('/'), 900);
      } else {
        const session = await authRequest('token?grant_type=password', { email: email.trim(), password }) as SupabaseSession;
        if (!session.user.email_confirmed_at) { saveSession(null); throw new Error('Please verify your email using the link we sent before signing in.'); }
        saveSession(session); location.assign('/');
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not complete that request.'); }
    finally { setBusy(false); }
  }

  const title = mode === 'signup' ? 'Join the journey' : mode === 'recover' ? 'Reset your password' : mode === 'update' ? 'Choose a new password' : 'Welcome back';
  const description = mode === 'signup' ? 'Create an account to find and share rides in Karachi.' : mode === 'recover' ? 'We’ll email you a secure password reset link.' : mode === 'update' ? 'Use a strong password you have not used before.' : 'Sign in to pick up where your next journey begins.';

  return <main className="auth-page">
    <section className="auth-aside"><a className="brand" href="/"><span className="brand-icon"><CarFront size={24}/></span>humsafar</a><div className="auth-story"><p className="eyebrow">BETTER JOURNEYS, TOGETHER</p><h1>Good journeys start with trust.</h1><p>Meet verified travellers, share the ride, and get there together.</p><div className="auth-promise"><ShieldCheck size={19}/> Email verification helps keep the community safer.</div></div><span className="auth-aside-foot">Humsafar · Karachi carpool pilot</span></section>
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
