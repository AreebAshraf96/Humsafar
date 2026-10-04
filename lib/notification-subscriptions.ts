import { getStoredSession, supabaseConfig } from "./supabase-auth";

export async function saveNotificationSubscription(deviceToken: string) {
  const session = getStoredSession();

  if (!session?.access_token || !session.user?.id) {
    throw new Error("Please sign in before enabling notifications.");
  }

  const { url, anonKey } = supabaseConfig();

  const response = await fetch(
    `${url}/rest/v1/notification_subscriptions?on_conflict=user_id,device_token`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        user_id: session.user.id,
        device_token: deviceToken,
        enabled: true,
        updated_at: new Date().toISOString(),
      }),
    }
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Could not save notification subscription.");
  }
}