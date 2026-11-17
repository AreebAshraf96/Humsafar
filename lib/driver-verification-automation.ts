import type { VerificationContext } from '@/lib/driver-verification-server';

export type DocumentChecks = {
  state: 'review_required' | 'unavailable';
  expiryDate: string | null;
  expiryStatus: 'valid' | 'expired' | 'ambiguous' | 'unreadable';
  nameStatus: 'consistent' | 'different' | 'unreadable' | 'not_provided';
  licenceNumberPresent: boolean;
  reasons: string[];
};

export type AutomatedVerification = {
  state: 'not_run' | 'needs_review' | 'unavailable';
  documentChecks?: DocumentChecks;
  reasonCode: string;
  faceMatchStatus: 'match' | 'no_match' | 'no_face' | 'multiple_faces' | 'uncertain' | null;
  faceMatchScore: number | null;
  checkedAt: string;
};

type ModelResponse = {
  faceMatchStatus?: unknown;
  faceMatchScore?: unknown;
  documentChecks?: unknown;
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
  options: { declaredName?: string } = {},
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
  if (options.declaredName) form.set('declaredName', options.declaredName.slice(0,100));
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

  if (!output || typeof output !== 'object' || Array.isArray(output)) return unavailable('model_response_invalid');

  const faceMatchStatus = ['match', 'no_match', 'no_face', 'multiple_faces', 'uncertain'].includes(String(output.faceMatchStatus))
    ? output.faceMatchStatus as AutomatedVerification['faceMatchStatus'] : null;
  const faceMatchScore = typeof output.faceMatchScore === 'number' && Number.isFinite(output.faceMatchScore)
    && output.faceMatchScore >= -1 && output.faceMatchScore <= 1 ? output.faceMatchScore : null;
  if (!faceMatchStatus || (['match', 'no_match'].includes(faceMatchStatus) && faceMatchScore === null) || (['no_face', 'multiple_faces'].includes(faceMatchStatus) && output.faceMatchScore != null)) return unavailable('model_response_invalid');
  const minimumFaceScore = Number(process.env.DRIVER_VERIFICATION_FACE_MIN_SCORE || '0.383');
  const validThreshold = minimumFaceScore >= -1 && minimumFaceScore <= 1;

  let reasonCode = 'face_match_needs_review';
  if (!validThreshold) return unavailable('threshold_configuration_invalid');
  else if (faceMatchStatus === 'match' && faceMatchScore !== null && faceMatchScore >= minimumFaceScore) {
    reasonCode = 'face_match_passed_license_review_required';
  }

  // Face similarity is advisory. A human must still inspect the licence and
  // confirm its expiry and authenticity before approving the driver.
  return {
    state: 'needs_review', reasonCode, faceMatchStatus, faceMatchScore,
    documentChecks: readDocumentChecks(output.documentChecks),
    checkedAt: new Date().toISOString(),
  };
}

function readDocumentChecks(input: unknown): DocumentChecks | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (!['review_required','unavailable'].includes(String(value.state)) || !['valid','expired','ambiguous','unreadable'].includes(String(value.expiryStatus)) || !['consistent','different','unreadable','not_provided'].includes(String(value.nameStatus)) || !Array.isArray(value.reasons)) return undefined;
  return {
    state: value.state as DocumentChecks['state'],
    expiryDate: typeof value.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.expiryDate) && Number.isFinite(Date.parse(value.expiryDate)) ? value.expiryDate : null,
    expiryStatus: value.expiryStatus as DocumentChecks['expiryStatus'],
    nameStatus: value.nameStatus as DocumentChecks['nameStatus'],
    licenceNumberPresent: value.licenceNumberPresent === true,
    reasons: value.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0,10).map(reason => reason.slice(0,200)),
  };
}
