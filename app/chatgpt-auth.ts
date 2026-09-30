import { headers } from "next/headers";

export type ChatGPTUser = { userId: string; displayName: string; email: string; fullName: string | null };

// Kept under the existing import name to avoid touching every ride route.
// Identity is verified with Supabase Auth; client-provided user IDs are never trusted.
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const authorization = (await headers()).get("authorization");
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!accessToken || !url || !anonKey) return null;
  try {
    const response = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const user = await response.json() as { id?: string; email?: string; email_confirmed_at?: string | null; user_metadata?: { full_name?: string; name?: string } };
    if (!user.id || !user.email || !user.email_confirmed_at) return null;
    const fullName = user.user_metadata?.full_name || user.user_metadata?.name || null;
    return { userId: user.id, displayName: fullName || user.email, email: user.email, fullName };
  } catch { return null; }
}

export async function requireChatGPTUser(): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (!user) throw new Error("Please sign in with a verified Humsafar account.");
  return user;
}
