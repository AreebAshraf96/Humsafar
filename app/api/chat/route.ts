import { waitUntil } from 'cloudflare:workers';
import { ApiError } from '@/lib/supabase-server';
import { sendManyHumsafarNotifications } from '@/lib/notifications-server';

export const dynamic = 'force-dynamic';

const json = (data: unknown, status = 200) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new ApiError('Supabase is not configured.', 503);
  return { url, key };
}

function bearer(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.match(/^Bearer\s+\S+$/i)) throw new ApiError('Please sign in to continue.', 401);
  return authorization;
}

async function verifiedUser(request: Request) {
  const authorization = bearer(request);
  const { url, key } = config();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: authorization },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new ApiError('Please sign in with a verified account.', 401);
  const user = await response.json() as { id?: string; email_confirmed_at?: string | null };
  if (!user.id || !user.email_confirmed_at) throw new ApiError('Please sign in with a verified account.', 401);
  return { userId: user.id, authorization, url, key };
}

async function rest<T>(url: string, key: string, authorization: string, init?: RequestInit): Promise<T> {
  const headers = new Headers({ apikey: key, Authorization: authorization });
  if (init?.body) headers.set('Content-Type', 'application/json');
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const databaseError = await response.json().catch(() => null) as {
      code?: string;
      message?: string;
      details?: string;
      hint?: string;
    } | null;
    console.error('Chat database request failed', {
      status: response.status,
      endpoint: new URL(url).pathname,
      code: databaseError?.code,
      message: databaseError?.message,
      details: databaseError?.details,
      hint: databaseError?.hint,
    });
    if (response.status === 401) throw new ApiError('Please sign in again.', 401);
    if (response.status === 403) throw new ApiError('You are not allowed to access this ride chat.', 403);
    if (response.status === 404) throw new ApiError('Ride chat not found.', 404);
    throw new ApiError('Chat is temporarily unavailable. Please try again.', 503);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
  const responseText = await response.text();
  return (responseText ? JSON.parse(responseText) : undefined) as T;
}

function failure(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return json({ error: 'Invalid request.' }, 400);
  console.error('Chat request failed', error instanceof Error ? error.name : 'Unknown error');
  return json({ error: 'Chat is temporarily unavailable. Please try again.' }, 503);
}

export async function GET(request: Request) {
  try {
    const rideId = new URL(request.url).searchParams.get('rideId') || '';
    if (!uuidPattern.test(rideId)) throw new ApiError('Choose a valid ride.', 400);
    const { userId, authorization, url, key } = await verifiedUser(request);
    const query = new URLSearchParams({
      select: 'id,ride_id,sender_id,body,created_at',
      ride_id: `eq.${rideId}`,
      order: 'created_at.asc',
      limit: '100',
    });
    const messages = await rest<Array<{ id: string; sender_id: string; body: string; created_at: string }>>(
      `${url}/rest/v1/ride_messages?${query}`,
      key,
      authorization,
    );
    let readReceipts: Array<{ message_id: string; reader_id: string }> = [];
    if (messages.length) {
      const messageIds = messages.map(message => message.id);
      const receiptsQuery = new URLSearchParams({
        select: 'message_id,reader_id',
        ride_id: `eq.${rideId}`,
        message_id: `in.(${messageIds.join(',')})`,
      });
      try {
        readReceipts = await rest<Array<{ message_id: string; reader_id: string }>>(
          `${url}/rest/v1/ride_message_reads?${receiptsQuery}`,
          key,
          authorization,
        );
        const alreadyRead = new Set(readReceipts.map(receipt => `${receipt.message_id}:${receipt.reader_id}`));
        const unreadMessages = messages.filter(message =>
          message.sender_id !== userId && !alreadyRead.has(`${message.id}:${userId}`),
        );
        if (unreadMessages.length) {
          await rest(`${url}/rest/v1/ride_message_reads?on_conflict=message_id%2Creader_id`, key, authorization, {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify(unreadMessages.map(message => ({
              ride_id: rideId,
              message_id: message.id,
              reader_id: userId,
            }))),
          });
          readReceipts.push(...unreadMessages.map(message => ({ message_id: message.id, reader_id: userId })));
        }
      } catch (error) {
        // A missing read-receipt migration must not prevent the chat history from loading.
        console.error('Chat read receipts unavailable', error instanceof Error ? error.message : 'Unknown error');
      }
    }
    const profileIds = [...new Set([
      ...messages.map(message => message.sender_id),
      ...readReceipts.map(receipt => receipt.reader_id),
    ])];
    const names = new Map<string, string>();
    if (profileIds.length) {
      const profilesQuery = new URLSearchParams({ select: 'id,name', id: `in.(${profileIds.join(',')})` });
      const profiles = await rest<Array<{ id: string; name: string }>>(
        `${url}/rest/v1/profiles?${profilesQuery}`,
        key,
        authorization,
      );
      for (const profile of profiles) names.set(profile.id, profile.name);
    }
    return json({ messages: messages.map(message => ({
      ...message,
      sender_name: names.get(message.sender_id) || 'Humsafar user',
      read_by: [...new Set(readReceipts
        .filter(receipt => receipt.message_id === message.id && receipt.reader_id !== message.sender_id)
        .map(receipt => names.get(receipt.reader_id) || 'Ride participant'))],
    })) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      throw new ApiError('Cross-origin requests are not allowed.', 403);
    }
    if (Number(request.headers.get('content-length')) > 10000) throw new ApiError('Message is too large.', 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 10000) throw new ApiError('Message is too large.', 413);
    const input = JSON.parse(text) as { rideId?: unknown; body?: unknown };
    if (!input || typeof input !== 'object' || typeof input.rideId !== 'string' || !uuidPattern.test(input.rideId)) {
      throw new ApiError('Choose a valid ride.', 400);
    }
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.trim().length > 2000) {
      throw new ApiError('Messages must contain between 1 and 2000 characters.', 400);
    }
    const { userId, authorization, url, key } = await verifiedUser(request);
    const inserted = await rest<Array<{ id: string; ride_id: string; sender_id: string; body: string; created_at: string }>>(
      `${url}/rest/v1/ride_messages?select=id,ride_id,sender_id,body,created_at`,
      key,
      authorization,
      {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ride_id: input.rideId, sender_id: userId, body: input.body.trim() }),
      },
    );
    if (!inserted[0]) throw new ApiError('Could not send that message.', 503);
    try {
      const recipients = await rest<Array<{ user_id: string }>>(
        `${url}/rest/v1/rpc/humsafar_chat_notification_targets`,
        key,
        authorization,
        { method: 'POST', body: JSON.stringify({ p_ride_id: input.rideId }) },
      );
      if (recipients.length) {
        waitUntil(sendManyHumsafarNotifications(recipients.map(recipient => recipient.user_id), {
          title: 'New ride chat message',
          body: 'Open Humsafar to read the latest message.',
          category: 'chat_messages',
          url: `/?chat=${encodeURIComponent(input.rideId)}`,
        }));
      }
    } catch (error) {
      // Push delivery is best-effort and must not undo a sent message.
      console.error('Could not queue ride chat notifications', error instanceof Error ? error.message : 'Unknown error');
    }
    return json({ message: inserted[0] }, 201);
  } catch (error) { return failure(error); }
}
