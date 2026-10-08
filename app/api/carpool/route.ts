import { waitUntil } from 'cloudflare:workers';
import { supabaseRpc, ApiError } from '@/lib/supabase-server';
import { endpointMatches, validatePlace } from '@/lib/locations';
import { routeMatches } from '@/lib/domain';
import { sendHumsafarNotification } from '@/lib/notifications-server';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
});
const readActions = new Set(['me', 'rides', 'trips', 'detail']);
const writeActions = new Set(['profile', 'create', 'request', 'approve', 'decline', 'cancelBooking', 'seats', 'status', 'location', 'share', 'revokeShare', 'track']);

function failure(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return json({ error: 'Invalid request.' }, 400);
  console.error('Carpool request failed', error instanceof Error ? error.name : 'Unknown error');
  return json({ error: 'Could not complete the request. Please try again.' }, 503);
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const action = params.get('action') || 'rides';
    if (!readActions.has(action)) throw new ApiError('Unknown action.', 400);
    const input = Object.fromEntries(params);
    const result = await supabaseRpc(request, 'humsafar_api', { p_action: action, p_input: input });
    if (action === 'rides') {
      let from = null, to = null;
      try {
        if (input.fromPoint) from = validatePlace(JSON.parse(input.fromPoint));
        if (input.toPoint) to = validatePlace(JSON.parse(input.toPoint));
      } catch { throw new ApiError('Choose and confirm valid Karachi locations.', 400); }
      if (!Array.isArray(result.rides)) throw new ApiError('Invalid database response.', 503);
      result.rides = result.rides.filter(r =>
        from || to ? endpointMatches(r.origin_point, from) && endpointMatches(r.destination_point, to)
          : routeMatches(r.origin, r.destination, r.stops, input.from || '', input.to || ''));
    }
    return json(result);
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      throw new ApiError('Cross-origin requests are not allowed.', 403);
    }
    if (Number(request.headers.get('content-length')) > 20000) throw new ApiError('Request too large.', 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 20000) throw new ApiError('Request too large.', 413);
    const input = JSON.parse(text);
    if (!input || typeof input !== 'object' || !writeActions.has(input.action)) throw new ApiError('Unknown action.', 400);
    const result = await supabaseRpc(request, 'humsafar_api', { p_action: input.action, p_input: input });
    const events = result._notifications || [];
    delete result._notifications;
    if (events.length) waitUntil(Promise.allSettled(events.map(sendHumsafarNotification)));
    return json(result);
  } catch (error) { return failure(error); }
}
