'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { authRequest, saveSession, validSession } from '@/lib/supabase-auth';

export function loginUrl() {
  // Keep private share tokens out of query strings, server logs and referrers.
  sessionStorage.setItem('humsafar.returnTo', '/' + location.hash);
  return '/auth';
}

export default function LoginGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    async function verify() {
      try {
        const session = await validSession();
        if (!session) { location.replace(loginUrl()); return; }
        const user = await authRequest('user', undefined, session.access_token);
        if (!user.email_confirmed_at) { saveSession(null); location.replace(loginUrl()); return; }
        if (active) setReady(true);
      } catch {
        if (active) setError('We could not verify your session. Check your connection and sign in again.');
      }
    }
    void verify();
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'humsafar.supabase.session' && !event.newValue) location.replace(loginUrl());
    };
    window.addEventListener('storage', onStorage);
    return () => { active = false; window.removeEventListener('storage', onStorage); };
  }, []);
  if (!ready) return <main className="auth-loading" aria-live="polite"><div className="brand">humsafar</div><p>{error || 'Checking your secure session…'}</p>{error && <a className="primary" href="/auth">Sign in again</a>}</main>;
  return children;
}
