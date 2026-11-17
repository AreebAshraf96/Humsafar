import type { VerificationContext } from '@/lib/driver-verification-server';

export type AutomatedVerification = {
  state: 'needs_review' | 'unavailable';
  reasonCode: string;
  faceMatchStatus: 'match' | 'no_match' | 'no_face' | 'multiple_faces' | 'uncertain' | null;
  faceMatchScore: number | null;
  checkedAt: string;
};

type ModelResponse = {
  faceMatchStatus?: unknown;
  faceMatchScore?: unknown;
};

function unavailable(reasonCode: string): AutomatedVerification {
  return {
    state: 'unavailable', reasonCode, faceMatchStatus: null, faceMatchScore: null,
    checkedAt: new Date().toISOString(),
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

  const faceMatchStatus = ['match', 'no_match', 'no_face', 'multiple_faces', 'uncertain'].includes(String(output.faceMatchStatus))
    ? output.faceMatchStatus as AutomatedVerification['faceMatchStatus'] : null;
  const faceMatchScore = typeof output.faceMatchScore === 'number' && Number.isFinite(output.faceMatchScore)
    && output.faceMatchScore >= -1 && output.faceMatchScore <= 1 ? output.faceMatchScore : null;
  const minimumFaceScore = Number(process.env.DRIVER_VERIFICATION_FACE_MIN_SCORE || '0.383');
  const validThreshold = minimumFaceScore >= -1 && minimumFaceScore <= 1;

  let reasonCode = 'face_match_needs_review';
  if (!validThreshold) reasonCode = 'threshold_configuration_invalid';
  else if (faceMatchStatus === 'match' && faceMatchScore !== null && faceMatchScore >= minimumFaceScore) {
    reasonCode = 'face_match_passed_license_review_required';
  }

  // Face similarity is advisory. A human must still inspect the licence and
  // confirm its expiry and authenticity before approving the driver.
  return {
    state: 'needs_review', reasonCode, faceMatchStatus, faceMatchScore,
    checkedAt: new Date().toISOString(),
  };
}
