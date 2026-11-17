import {
  DriverVerificationError, supabaseRequest, type VerificationContext,
  readStoredImage, readVerificationJson, serviceRoleRequest, verificationContext, verificationFailure,
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
      licence_expiry_date: string | null; submitted_at: string; reviewed_at: string | null; retention_until: string | null;
      automated_result: AutomatedVerification; automated_checked_at: string | null;
    }>>(context, `/rest/v1/driver_verifications?select=id,status,vehicle_registration_number,review_reason,licence_expiry_date,submitted_at,reviewed_at,retention_until,automated_result,automated_checked_at&user_id=eq.${context.userId}&limit=1`);
    const application = rows[0];
    const automationAvailable = !!((process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) && process.env.DRIVER_VERIFICATION_MODEL_URL && process.env.DRIVER_VERIFICATION_MODEL_KEY);
    if (application?.status === 'pending' && !automationAvailable) application.automated_result = { state: 'unavailable', reasonCode: 'manual_review_available', faceMatchStatus: null, faceMatchScore: null, checkedAt: new Date().toISOString() };
    if (application?.status === 'approved' && (!application.licence_expiry_date || application.licence_expiry_date < new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))) {
      application.status = 'action_required';
      application.review_reason = 'Your licence approval has expired or needs an expiry date confirmed. Submit current documents for review.';
    }
    return Response.json({ ...(application || { status: 'not_submitted' }), automation_available: automationAvailable }, { headers: { 'Cache-Control': 'no-store' } });
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

async function ensureCanSubmit(context: VerificationContext, expected?: string) {
  const current = await supabaseRequest<Array<{ status: string; licence_expiry_date: string | null; submitted_at: string; licence_storage_path: string | null; selfie_storage_path: string | null }>>(context,
    `/rest/v1/driver_verifications?select=status,licence_expiry_date,submitted_at,licence_storage_path,selfie_storage_path&user_id=eq.${context.userId}&limit=1`);
  if(expected&&(!current[0]||current[0].status!=='pending'||Date.parse(current[0].submitted_at)!==Date.parse(expected)))throw new DriverVerificationError('Your request changed while you were replacing photos. Refresh to see the latest review.',409);
  const expired = current[0]?.status === 'approved' && (!current[0].licence_expiry_date || current[0].licence_expiry_date < new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
  if (current[0] && !expired && !(expected&&current[0].status==='pending') && !['rejected', 'action_required'].includes(current[0].status)) {
    throw new DriverVerificationError(current[0].status === 'approved'
      ? 'Your driver verification is already approved.'
      : 'Your application is pending review.', 409);
  }
  return current[0];
}

export async function POST(request: Request) {
  let context: VerificationContext | undefined;
  try {
    context = await verificationContext(request);

    const payload = await readVerificationJson(request) as {
      action?: string; licencePath?: string; selfiePath?: string; registration?: string; paths?: string[]; declaredName?: string; replaceSubmittedAt?: string;
    };
    if(payload.replaceSubmittedAt!==undefined&&(typeof payload.replaceSubmittedAt!=='string'||!Number.isFinite(Date.parse(payload.replaceSubmittedAt))))throw new DriverVerificationError('Invalid replacement request.',400);
    if (payload.declaredName !== undefined && (typeof payload.declaredName !== 'string' || payload.declaredName.trim().length < 2 || payload.declaredName.length > 100)) throw new DriverVerificationError('Enter your full name as printed on the licence.', 400);
    if (payload.action === 'retry_automation') {
      if (!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
        throw new DriverVerificationError('Automated verification is not configured on the server.', 503);
      }
      const existing = await supabaseRequest<Array<{
        id: string; status: string; licence_storage_path: string | null; selfie_storage_path: string | null;
        automated_result: { state?: string; documentChecks?: { state?: string } } | null; submitted_at: string;
      }>>(context, `/rest/v1/driver_verifications?select=id,status,licence_storage_path,selfie_storage_path,automated_result,submitted_at&user_id=eq.${context.userId}&limit=1`);
      const application = existing[0];
      if (!application || application.status !== 'pending' || (application.automated_result?.state !== 'unavailable' && application.automated_result?.documentChecks && application.automated_result.documentChecks.state !== 'unavailable')) {
        throw new DriverVerificationError('Only pending applications with missing or unavailable checks can be checked again.', 409);
      }
      const { licence_storage_path: licencePath, selfie_storage_path: selfiePath } = application;
      if (!licencePath || !selfiePath || !uploadPathPattern(context.userId).test(licencePath)
        || !uploadPathPattern(context.userId).test(selfiePath)) {
        throw new DriverVerificationError('The stored verification documents are unavailable. Please contact an administrator.', 409);
      }
      const [licenceImage, selfieImage] = await Promise.all([
        readStoredImage(context, licencePath), readStoredImage(context, selfiePath),
      ]);
      const automation = await runAutomatedVerification(context, licenceImage, selfieImage, { declaredName: payload.declaredName?.trim() });
      try {
        const saved = await serviceRoleRequest<Array<{ id: string }>>(context, `/rest/v1/driver_verifications?id=eq.${application.id}&user_id=eq.${context.userId}&status=eq.pending&submitted_at=eq.${encodeURIComponent(application.submitted_at)}&licence_storage_path=eq.${encodeURIComponent(licencePath)}&selfie_storage_path=eq.${encodeURIComponent(selfiePath)}`, {
          method: 'PATCH', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            automated_result: automation,
            automated_checked_at: automation.checkedAt,
            updated_at: automation.checkedAt,
          }),
        });
        if (!saved.length) return GET(request);
      } catch {
        throw new DriverVerificationError('The checks ran, but Humsafar could not save the result. Check the server database configuration.', 503);
      }
      return GET(request);
    }
    if (payload.action === 'cleanup') {
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      if (paths.some(path => typeof path !== 'string' || !uploadPathPattern(context!.userId).test(path))) {
        throw new DriverVerificationError('Invalid uploaded document path.', 400);
      }
      await removeUploadedDocuments(context, paths);
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (payload.action !== 'submit') throw new DriverVerificationError('Invalid verification request.', 400);

    for(const path of [payload.licencePath,payload.selfiePath])if(path!==undefined&&(typeof path!=='string'||!uploadPathPattern(context.userId).test(path)))throw new DriverVerificationError('Invalid uploaded document path.',400);
    if(payload.replaceSubmittedAt&&!payload.licencePath&&!payload.selfiePath)throw new DriverVerificationError('Choose at least one new photo.',400);
    const current=await ensureCanSubmit(context,payload.replaceSubmittedAt);
    const licencePath=payload.licencePath||(payload.replaceSubmittedAt?current?.licence_storage_path:undefined);
    const selfiePath=payload.selfiePath||(payload.replaceSubmittedAt?current?.selfie_storage_path:undefined);
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
    const [licenceImage, selfieImage] = await Promise.all([
      readStoredImage(context, licencePath), readStoredImage(context, selfiePath),
    ]);
    const automation: AutomatedVerification = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
      ? await runAutomatedVerification(context, licenceImage, selfieImage, { declaredName: payload.declaredName?.trim() })
      : {
        state: 'unavailable', reasonCode: 'server_database_key_missing',
          faceMatchStatus: null, faceMatchScore: null, checkedAt: new Date().toISOString(),
        };

    const result = await supabaseRequest<{
      id: string; status: string; submitted_at: string;
      old_licence_storage_path?: string | null; old_selfie_storage_path?: string | null;
    }>(context, '/rest/v1/rpc/humsafar_submit_driver_verification', {
      method: 'POST', body: JSON.stringify({
        p_licence_path: licencePath,
        p_selfie_path: selfiePath,
        p_vehicle_registration_number: registration,
        ...(payload.replaceSubmittedAt?{p_expected_submitted_at:payload.replaceSubmittedAt}:{}),
      }),
    });
    await removeUploadedDocuments(context, [result.old_licence_storage_path, result.old_selfie_storage_path].filter((path): path is string => !!path&&path!==licencePath&&path!==selfiePath));

    if ((process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
      try {
        await serviceRoleRequest(context, `/rest/v1/driver_verifications?id=eq.${result.id}&user_id=eq.${context.userId}&status=eq.pending&submitted_at=eq.${encodeURIComponent(result.submitted_at)}&licence_storage_path=eq.${encodeURIComponent(licencePath)}&selfie_storage_path=eq.${encodeURIComponent(selfiePath)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            automated_result: automation,
            automated_checked_at: automation.checkedAt,
            updated_at: automation.checkedAt,
          }),
        });

      } catch {
        // The existing RPC already created a pending application. If saving
        // automation metadata fails, keep it pending for an admin to review.
      }
    }
    return GET(request);
  } catch (error) {
    return verificationFailure(error);
  }
}
