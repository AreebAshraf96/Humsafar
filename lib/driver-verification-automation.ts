import type { VerificationContext } from '@/lib/driver-verification-server';

export type AutomatedVerification = {
  state: 'clear_pass' | 'needs_review' | 'unavailable';
  reasonCode: string;
  licenceExpiryDate: string | null;
  expiryConfidence: number | null;
  faceMatchStatus: 'match' | 'no_match' | 'no_face' | 'multiple_faces' | 'uncertain' | null;
  faceMatchScore: number | null;
  checkedAt: string;
};

type ModelResponse = {
  licenceExpiryDate?: unknown;
  expiryConfidence?: unknown;
  faceMatchStatus?: unknown;
  faceMatchScore?: unknown;
};

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function unavailable(reasonCode: string): AutomatedVerification {
  return {
    state: 'unavailable', reasonCode, licenceExpiryDate: null, expiryConfidence: null,
    faceMatchStatus: null, faceMatchScore: null, checkedAt: new Date().toISOString(),
  };
}

export async function runAutomatedVerification(
  context: VerificationContext,
  licence: Blob,
  selfie: Blob,
): Promise<AutomatedVerification> {
  const endpoint = process.env.DRIVER_VERIFICATION_MODEL_URL;
  const secret = process.env.DRIVER_VERIFICATION_MODEL_KEY;
  if (!endpoint || !secret) return unavailable('model_not_configured');

  let url: URL;
  try { url = new URL(endpoint); }
  catch { return unavailable('model_endpoint_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)) return unavailable('model_endpoint_invalid');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') return unavailable('model_endpoint_must_use_https');

  const form = new FormData();
  form.set('countryCode', 'PK');
  form.set('region', 'Sindh');
  form.set('licence', new File([licence], `licence.${licence.type.split('/')[1] || 'jpg'}`, { type: licence.type }));
  form.set('selfie', new File([selfie], `selfie.${selfie.type.split('/')[1] || 'jpg'}`, { type: selfie.type }));

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
      cache: 'no-store', signal: AbortSignal.timeout(45000),
    });
  } catch {
    return unavailable('model_unreachable');
  }
  if (!response.ok) return unavailable('model_request_failed');

  let output: ModelResponse;
  try {
    const text = await response.text();
    if (text.length > 20_000) return unavailable('model_response_invalid');
    output = JSON.parse(text) as ModelResponse;
  } catch {
    return unavailable('model_response_invalid');
  }

  const expiry = isDateOnly(output.licenceExpiryDate) ? output.licenceExpiryDate : null;
  const expiryConfidence = typeof output.expiryConfidence === 'number' && Number.isFinite(output.expiryConfidence)
    && output.expiryConfidence >= 0 && output.expiryConfidence <= 1 ? output.expiryConfidence : null;
  const faceMatchStatus = ['match', 'no_match', 'no_face', 'multiple_faces', 'uncertain'].includes(String(output.faceMatchStatus))
    ? output.faceMatchStatus as AutomatedVerification['faceMatchStatus'] : null;
  const faceMatchScore = typeof output.faceMatchScore === 'number' && Number.isFinite(output.faceMatchScore)
    && output.faceMatchScore >= 0 && output.faceMatchScore <= 100 ? output.faceMatchScore : null;

  const pakistanDateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const datePart = (type: string) => pakistanDateParts.find(part => part.type === type)?.value || '';
  const today = `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
  const minimumOcrConfidence = Number(process.env.DRIVER_VERIFICATION_OCR_MIN_CONFIDENCE || '0.9');
  const minimumFaceScore = Number(process.env.DRIVER_VERIFICATION_FACE_MIN_SCORE || '95');
  const validThresholds = minimumOcrConfidence >= 0 && minimumOcrConfidence <= 1
    && minimumFaceScore >= 0 && minimumFaceScore <= 100;
  const clearPass = validThresholds && !!expiry && expiry >= today
    && expiryConfidence !== null && expiryConfidence >= minimumOcrConfidence
    && faceMatchStatus === 'match' && faceMatchScore !== null && faceMatchScore >= minimumFaceScore;

  let reasonCode = 'checks_need_review';
  if (!validThresholds) reasonCode = 'threshold_configuration_invalid';
  else if (!expiry) reasonCode = 'expiry_date_not_read';
  else if (expiry < today) reasonCode = 'licence_expired';
  else if (expiryConfidence === null || expiryConfidence < minimumOcrConfidence) reasonCode = 'expiry_confidence_low';
  else if (faceMatchStatus !== 'match' || faceMatchScore === null || faceMatchScore < minimumFaceScore) reasonCode = 'face_match_needs_review';

  return {
    state: clearPass ? 'clear_pass' : 'needs_review',
    reasonCode: clearPass ? 'all_checks_passed' : reasonCode,
    licenceExpiryDate: expiry,
    expiryConfidence,
    faceMatchStatus,
    faceMatchScore,
    checkedAt: new Date().toISOString(),
  };
}
