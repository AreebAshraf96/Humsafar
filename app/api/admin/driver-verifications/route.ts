import { DriverVerificationError, supabaseRequest, verificationContext, verificationFailure } from '@/lib/driver-verification-server';

export const dynamic = 'force-dynamic';
const bucket = 'driver-verification';
type AdminVerificationRow = {
  [key: string]: unknown;
  licence_storage_path: string | null;
  selfie_storage_path: string | null;
};

async function requireAdmin(context: Awaited<ReturnType<typeof verificationContext>>) {
  return supabaseRequest<boolean>(context, '/rest/v1/rpc/humsafar_is_driver_verification_admin', { method: 'POST', body: '{}' });
}

function storageObjectPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function signedDocumentUrl(context: Awaited<ReturnType<typeof verificationContext>>, path: string) {
  const result = await supabaseRequest<{ signedURL?: string; signedUrl?: string }>(
    context, `/storage/v1/object/sign/${bucket}/${storageObjectPath(path)}`,
    { method: 'POST', body: JSON.stringify({ expiresIn: 1800 }) },
  );
  const signed = result.signedURL || result.signedUrl;
  if (!signed) throw new DriverVerificationError('Could not securely open a submitted document.', 503);
  return signed.startsWith('http') ? signed : `${context.url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
}

export async function GET(request: Request) {
  try {
    const context = await verificationContext(request);
    if (!(await requireAdmin(context))) throw new DriverVerificationError('Administrator access required.', 403);
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get('limit') || 50);
    const offset = Number(params.get('offset') || 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
      throw new DriverVerificationError('Choose a valid page of applications.', 400);
    }
    const rows = await supabaseRequest<AdminVerificationRow[]>(context,
      '/rest/v1/rpc/humsafar_admin_driver_verifications', { method: 'POST', body: JSON.stringify({ p_limit: limit, p_offset: offset }) });
    const applications = await Promise.all(rows.map(async application => ({
      ...application,
      licence_url: application.licence_storage_path ? await signedDocumentUrl(context, application.licence_storage_path) : null,
      selfie_url: application.selfie_storage_path ? await signedDocumentUrl(context, application.selfie_storage_path) : null,
      licence_storage_path: undefined,
      selfie_storage_path: undefined,
    })));
    return Response.json({ applications }, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch (error) { return verificationFailure(error); }
}

export async function POST(request: Request) {
  try {
    const context = await verificationContext(request);
    const input = await request.json() as { action?: unknown; id?: unknown; status?: unknown; reason?: unknown };
    if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id)) throw new DriverVerificationError('Choose a valid application.', 400);
    if (input.action === 'review') {
      if (!['approved', 'rejected', 'action_required'].includes(String(input.status))) throw new DriverVerificationError('Choose a valid review decision.', 400);
      const result = await supabaseRequest(context, '/rest/v1/rpc/humsafar_review_driver_verification', {
        method: 'POST', body: JSON.stringify({ p_id: input.id, p_status: input.status, p_reason: typeof input.reason === 'string' ? input.reason : '' }),
      });
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (input.action === 'purge') {
      if (!(await requireAdmin(context))) throw new DriverVerificationError('Administrator access required.', 403);
      const rows = await supabaseRequest<Array<{ licence_storage_path: string | null; selfie_storage_path: string | null; retention_until: string | null; status: string }>>(context,
        `/rest/v1/driver_verifications?select=licence_storage_path,selfie_storage_path,retention_until,status&id=eq.${input.id}&limit=1`);
      const row = rows[0];
      if (!row) throw new DriverVerificationError('Verification application not found.', 404);
      if (!row.retention_until || new Date(row.retention_until).getTime() > Date.now() || !['approved','rejected'].includes(row.status)) {
        throw new DriverVerificationError('Documents can be deleted 90 days after approval or rejection.', 403);
      }
      const paths = [row.licence_storage_path, row.selfie_storage_path].filter((path): path is string => !!path);
      if (paths.length) {
        await supabaseRequest(context, `/storage/v1/object/${bucket}`, {
          method: 'DELETE', body: JSON.stringify({ prefixes: paths }),
        });
      }
      const result = await supabaseRequest(context, '/rest/v1/rpc/humsafar_purge_driver_verification_documents', {
        method: 'POST', body: JSON.stringify({ p_id: input.id }),
      });
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
    throw new DriverVerificationError('Choose a valid action.', 400);
  } catch (error) { return verificationFailure(error); }
}
