export class DriverVerificationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type VerificationContext = {
  userId: string;
  authorization: string;
  accessToken: string;
  url: string;
  key: string;
};

export async function verificationContext(request: Request): Promise<VerificationContext> {
  const authorization = request.headers.get('authorization') || '';
  const accessToken = authorization.match(/^Bearer\s+(\S+)$/i)?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!accessToken || !url || !key) throw new DriverVerificationError('Please sign in to continue.', 401);
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: authorization }, cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new DriverVerificationError('Verification service is temporarily unavailable.', 503);
  }
  if (!response.ok) throw new DriverVerificationError('Please sign in again.', 401);
  const user = await response.json() as { id?: string; email_confirmed_at?: string | null };
  if (!user.id || !user.email_confirmed_at) throw new DriverVerificationError('Sign in with a verified account.', 401);
  return { userId: user.id, authorization, accessToken, url, key };
}

export async function supabaseRequest<T>(context: VerificationContext, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${context.url}${path}`, {
      ...init,
      headers: {
        apikey: context.key,
        Authorization: context.authorization,
        ...(init.body && !(init.body instanceof ArrayBuffer) && !(init.body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new DriverVerificationError('Verification service is temporarily unavailable.', 503);
  }
  const text = await response.text();
  const result = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!response.ok) {
    const code = result?.code;
    if (response.status === 401 || code === '28000' || code === 'PGRST301') throw new DriverVerificationError('Please sign in again.', 401);
    if (response.status === 403 || code === '42501') throw new DriverVerificationError(result?.message || 'You cannot perform this action.', 403);
    if (response.status === 404 || code === 'P0002') throw new DriverVerificationError('The requested verification record was not found.', 404);
    if (response.status === 400 || String(code || '').startsWith('22')) throw new DriverVerificationError(result?.message || 'Please check the information and try again.', 400);
    throw new DriverVerificationError('Could not complete the verification request. Please try again.', 503);
  }
  return result as T;
}

export function verificationFailure(error: unknown) {
  if (error instanceof DriverVerificationError) {
    return Response.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  }
  if (error instanceof SyntaxError) return Response.json({ error: 'Invalid request.' }, { status: 400 });
  console.error('Driver verification request failed', error instanceof Error ? error.name : 'Unknown error');
  return Response.json({ error: 'Could not complete the verification request. Please try again.' }, { status: 503 });
}

export function isAllowedImage(file: File): boolean {
  return file.size > 0 && file.size <= 5 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
}

export async function validImageBytes(file: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (file.type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.type === 'image/png') return [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((byte,index)=>bytes[index]===byte);
  if (file.type === 'image/webp') return String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  return false;
}

export async function readStoredImage(context: VerificationContext, path: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`${context.url}/storage/v1/object/driver-verification/${path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { apikey: context.key, Authorization: context.authorization },
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new DriverVerificationError('Verification service is temporarily unavailable.', 503);
  }
  if (!response.ok) throw new DriverVerificationError('One of the uploaded documents could not be read.', 400);
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > 5 * 1024 * 1024 || !(await validImageBytes(blob))) {
    throw new DriverVerificationError('One of the uploaded documents is too large or is not a valid supported image.', 400);
  }
  return blob;
}

export async function serviceRoleRequest<T>(context: VerificationContext, path: string, init: RequestInit = {}): Promise<T> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new DriverVerificationError('Server-side verification storage is not configured.', 503);
  let response: Response;
  try {
    response = await fetch(`${context.url}${path}`, {
      ...init,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new DriverVerificationError('Could not save automated verification results.', 503);
  }
  const text = await response.text();
  if (!response.ok) throw new DriverVerificationError('Could not save automated verification results.', 503);
  return (text ? JSON.parse(text) : null) as T;
}

export function imageExtension(file: File): 'jpg' | 'png' | 'webp' {
  return file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
}
