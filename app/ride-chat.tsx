'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageCircle, Send } from 'lucide-react';
import { validSession } from '@/lib/supabase-auth';

type ChatMessage = { id: string; sender_id: string; sender_name: string; body: string; created_at: string; read_by: string[] };
type ChatPage = { messages: ChatMessage[]; nextCursor: string | null; error?: string };

async function chatPage(rideId: string, before?: string, signal?: AbortSignal): Promise<ChatPage> {
  const session = await validSession();
  if (!session) throw new Error('Please sign in again.');
  const query = new URLSearchParams({ rideId });
  if (before) query.set('before', before);
  const response = await fetch(`/api/chat?${query}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store', signal });
  const data = await response.json() as ChatPage;
  if (!response.ok) throw new Error(data.error || 'Could not load chat.');
  return data;
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const messages = new Map(current.map(message => [message.id, message]));
  incoming.forEach(message => messages.set(message.id, message));
  return [...messages.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export default function RideChat({ rideId, userId, canSend }: { rideId: string; userId?: string; canSend: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const initialized = useRef(false);
  const latest = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const first = await chatPage(rideId, undefined, signal);
    let incoming = first.messages;
    // If more than one page arrived since the last poll, fill the gap too.
    let next = first.nextCursor;
    const previousLatest = latest.current;
    while (previousLatest && next && !incoming.some(message => message.id === previousLatest)) {
      const older = await chatPage(rideId, next, signal);
      incoming = [...older.messages, ...incoming];
      next = older.nextCursor;
    }
    if (signal?.aborted) return;
    if (!initialized.current) { setCursor(first.nextCursor); initialized.current = true; }
    latest.current = first.messages.at(-1)?.id || latest.current;
    setMessages(current => mergeMessages(current, incoming));
    setError('');
  }, [rideId]);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try { await refresh(controller.signal); }
      catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
      finally { pending = false; }
    };
    const start = setTimeout(() => void poll(), 0);
    const interval = setInterval(() => void poll(), 5000);
    return () => { controller.abort(); clearTimeout(start); clearInterval(interval); };
  }, [refresh]);

  const newestMessageId = messages.at(-1)?.id;
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [newestMessageId]);

  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try { const page = await chatPage(rideId, cursor); setMessages(current => mergeMessages(current, page.messages)); setCursor(page.nextCursor); }
    catch (error) { setError((error as Error).message); }
    finally { setLoadingOlder(false); }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get('body') || '').trim();
    if (!body || busy || !canSend) return;
    setBusy(true); setError('');
    try {
      const session = await validSession();
      if (!session) throw new Error('Please sign in again.');
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ rideId, body }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not send message.');
      form.reset(); await refresh();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="ride-chat" aria-label="Ride chat">
    <header className="ride-chat-header"><span className="ride-chat-heading-icon"><MessageCircle size={20}/></span><div><h3>Ride chat</h3><p>Driver and approved passengers</p></div><span className="ride-chat-tag">Ride group</span></header>
    {error && <p className="banner error ride-chat-error" role="alert">{error}</p>}
    {cursor && <button className="subtle" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older messages'}</button>}
    <div className="ride-chat-messages" role="log" aria-live="polite" aria-label="Chat messages">
      {!messages.length ? <div className="ride-chat-empty"><MessageCircle size={27}/><strong>No messages yet</strong><span>Say hello to everyone on this ride.</span></div> : messages.map(message => <div key={message.id} className={`ride-chat-row ${message.sender_id === userId ? 'is-own' : ''}`}><div className="ride-chat-bubble">{message.sender_id !== userId && <span className="ride-chat-sender">{message.sender_name}</span>}<p>{message.body}</p><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' })}</time>{message.sender_id === userId && message.read_by.length > 0 && <span className="ride-chat-receipt">Seen by {message.read_by.join(', ')}</span>}</div></div>)}
      <div ref={end}/>
    </div>
    {canSend ? <form className="ride-chat-composer" onSubmit={send}><textarea name="body" rows={1} maxLength={2000} required aria-label="Message" placeholder="Write a message…" className="ride-chat-input" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/><button className="ride-chat-send" type="submit" disabled={busy} aria-label="Send message"><Send size={18}/></button></form> : <p className="muted">This trip has ended. Chat history is read-only.</p>}
  </section>;
}
