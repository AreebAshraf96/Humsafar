import type { SendNotificationInput } from './notifications-server';

type RideSummary = {
  origin: string; destination: string; stops: string;
  origin_point?: string; destination_point?: string;
};
type RpcResult = {
  rides?: RideSummary[];
  _notifications?: SendNotificationInput[];
  code?: string; message?: string;
  [key: string]: unknown;
};

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function supabaseRpc(request: Request, name: string, body: unknown): Promise<RpcResult> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.match(/^Bearer\s+\S+$/i)) throw new ApiError('Please sign in to continue.', 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new ApiError('Supabase is not configured.', 503);
  // The review launcher uses real Supabase authentication with an isolated local
  // PostgreSQL database. This cannot be activated on a production/public host.
  const preview = process.env.NODE_ENV === 'development' && ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)
    ? process.env.HUMSAFAR_PREVIEW_RPC_URL : undefined;
  if (preview && new URL(preview).hostname !== '127.0.0.1') throw new ApiError('Invalid preview configuration.', 503);
  const response = await fetch(`${preview || url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: key, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(12000),
  });
  const result = await response.json() as RpcResult;
  if (!response.ok) {
    const code = result.code;
    if (response.status === 401 || code === '28000' || code === 'PGRST301') throw new ApiError('Please sign in with a verified account.', 401);
    if (code === '42501') throw new ApiError(result.message || 'You cannot perform this action.', 403);
    if (code === 'P0002') throw new ApiError(result.message || 'Not found.', 404);
    if (code === '22023') throw new ApiError(result.message || 'Invalid request.', 400);
    if (String(code).startsWith('22') || String(code).startsWith('23')) throw new ApiError('Please check the entered values.', 400);
    if (code === 'PGRST202' || code === '42883') throw new ApiError('The secure database update is not installed yet.', 503);
    throw new ApiError('Database request failed. Please try again.', 503);
  }
  if (preview) delete result._notifications;
  return result;
}
