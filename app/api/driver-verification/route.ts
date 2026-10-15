import {
  DriverVerificationError, supabaseRequest, type VerificationContext,
  readStoredImage, serviceRoleRequest, verificationContext, verificationFailure,
} from '@/lib/driver-verification-server';
import { runAutomatedVerification, type AutomatedVerification } from '@/lib/driver-verification-automation';

export const dynamic = 'force-dynamic';
const bucket = 'driver-verification';
const uploadPathPattern = (userId: string) => new RegExp(`^${userId}/[0-9a-f-]{36}/(?:licence|selfie)\\.(?:jpg|png|webp)$`, 'i');

export async function GET(request: Request) {
  try {
    const context = await verificationContext(request);
    const rows = await supabaseRequest<Array<{
      id: string; status: string; vehicle_registration_number: string; review_reason: string | null;
      submitted_at: string; reviewed_at: string | null; retention_until: string | null;
      licence_expiry_date: string | null; automated_result: AutomatedVerification; automated_checked_at: string | null;
    }>>(context, `/rest/v1/driver_verifications?select=id,status,vehicle_registration_number,review_reason,submitted_at,reviewed_at,retention_until,licence_expiry_date,automated_result,automated_checked_at&user_id=eq.${context.userId}&limit=1`);
    const application = rows[0];
    return Response.json(application || { status: 'not_submitted' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return verificationFailure(error); }
}

async function removeUploadedDocuments(context: VerificationContext, paths: string[]) {
  if (!paths.length) return;
  try {
    await supabaseRequest(context, `/storage/v1/object/${bucket}`, {
      method: 'DELETE', body: JSON.stringify({ prefixes: paths }),
    });
  } catch { /* Cleanup is best effort; do not log private object paths. */ }
}

async function ensureCanSubmit(context: VerificationContext) {
  const current = await supabaseRequest<Array<{ status: string }>>(context,
    `/rest/v1/driver_verifications?select=status&user_id=eq.${context.userId}&limit=1`);
  if (current[0] && !['rejected', 'action_required'].includes(current[0].status)) {
    throw new DriverVerificationError(current[0].status === 'approved'
      ? 'Your driver verification is already approved.'
      : 'Your application is pending review.', 409);
  }
}

export async function POST(request: Request) {
  let context: VerificationContext | undefined;
  try {
    context = await verificationContext(request);

    const payload = await request.json() as {
      action?: string; licencePath?: string; selfiePath?: string; registration?: string; paths?: string[];
    };
    if (payload.action === 'cleanup') {
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      if (paths.some(path => typeof path !== 'string' || !uploadPathPattern(context!.userId).test(path))) {
        throw new DriverVerificationError('Invalid uploaded document path.', 400);
      }
      await removeUploadedDocuments(context, paths);
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (payload.action !== 'submit') throw new DriverVerificationError('Invalid verification request.', 400);

    const { licencePath, selfiePath } = payload;
    if (typeof licencePath !== 'string' || typeof selfiePath !== 'string'
      || !uploadPathPattern(context.userId).test(licencePath)
      || !uploadPathPattern(context.userId).test(selfiePath)
      || !/\/licence\.(?:jpg|png|webp)$/i.test(licencePath)
      || !/\/selfie\.(?:jpg|png|webp)$/i.test(selfiePath)
      || licencePath === selfiePath) {
      throw new DriverVerificationError('Upload both documents before submitting.', 400);
    }
    const registration = String(payload.registration || '').trim().toUpperCase();
    if (!/^[A-Z0-9 -]{3,20}$/.test(registration)) throw new DriverVerificationError('Enter a valid vehicle registration number.', 400);
    await ensureCanSubmit(context);
    const [licenceImage, selfieImage] = await Promise.all([
      readStoredImage(context, licencePath), readStoredImage(context, selfiePath),
    ]);
    const automation: AutomatedVerification = process.env.SUPABASE_SERVICE_ROLE_KEY
      ? await runAutomatedVerification(context, licenceImage, selfieImage)
      : {
          state: 'unavailable', reasonCode: 'server_database_key_missing', licenceExpiryDate: null,
          expiryConfidence: null, faceMatchStatus: null, faceMatchScore: null, checkedAt: new Date().toISOString(),
        };

    const result = await supabaseRequest<{
      id: string; status: string; submitted_at: string;
      old_licence_storage_path?: string | null; old_selfie_storage_path?: string | null;
    }>(context, '/rest/v1/rpc/humsafar_submit_driver_verification', {
      method: 'POST', body: JSON.stringify({
        p_licence_path: licencePath,
        p_selfie_path: selfiePath,
        p_vehicle_registration_number: registration,
      }),
    });
    await removeUploadedDocuments(context, [result.old_licence_storage_path, result.old_selfie_storage_path].filter((path): path is string => !!path));
    let savedAutomation = false;
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const autoApproved = automation.state === 'clear_pass';
      const retentionUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      try {
        await serviceRoleRequest(context, `/rest/v1/driver_verifications?id=eq.${result.id}&user_id=eq.${context.userId}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: autoApproved ? 'approved' : 'pending',
            licence_expiry_date: automation.licenceExpiryDate,
            automated_result: automation,
            automated_checked_at: automation.checkedAt,
            ...(autoApproved ? { reviewed_at: automation.checkedAt, retention_until: retentionUntil } : {}),
            updated_at: automation.checkedAt,
          }),
        });
        savedAutomation = true;
      } catch {
        // The existing RPC already created a pending application. If saving
        // automation metadata fails, keep it pending for an admin to review.
      }
    }
    const finalStatus = savedAutomation && automation.state === 'clear_pass' ? 'approved' : 'pending';
    return Response.json({
      id: result.id, status: finalStatus, submitted_at: result.submitted_at,
      automated_result: savedAutomation ? automation : { ...automation, state: 'unavailable' as const, reasonCode: 'result_save_failed' },
      licence_expiry_date: savedAutomation ? automation.licenceExpiryDate : null,
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return verificationFailure(error);
  }
}
