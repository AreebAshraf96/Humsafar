import { supabaseConfig, validSession } from './supabase-auth';
import { removePushToken, setPushAccount } from './firebase-notifications';
const TOKEN_KEY = 'humsafar.notification.token';

async function device(token: string, enabled: boolean) {
  const session = await validSession();
  if (!session) throw new Error('Please sign in before changing notifications.');
  const { url, anonKey } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/rpc/humsafar_device`, {
    method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token, p_enabled: enabled }), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Could not update notification subscription. Please retry.');
  return session.user.id;
}

export async function saveNotificationSubscription(token: string) {
  const userId = await device(token, true);
  localStorage.setItem(TOKEN_KEY, token);
  await setPushAccount(userId);
}

export async function disableNotifications() {
  // Suppress this account's pushes locally before making network requests.
  const privacy = setPushAccount(null);
  const token = localStorage.getItem(TOKEN_KEY);
  const outcomes = await Promise.allSettled([
    privacy,
    token ? device(token, false) : Promise.resolve(),
    token ? removePushToken() : Promise.resolve(),
  ]);
  if (outcomes.every(result => result.status === 'fulfilled')) localStorage.removeItem(TOKEN_KEY);
  if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
  // Keep a failed token for a later cleanup attempt. Worker privacy remains off.
}
