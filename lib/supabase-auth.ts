export type SupabaseSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: { id: string; email?: string; email_confirmed_at?: string | null };
};

const SESSION_KEY = "humsafar.supabase.session";

export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  return { url, anonKey };
}

export function getStoredSession(): SupabaseSession | null {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) as SupabaseSession : null;
  } catch { return null; }
}

export function saveSession(session: SupabaseSession | null) {
  if (typeof window === "undefined") return;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export async function authRequest(path: string, body?: unknown, token?: string, method?: "POST" | "PUT") {
  const { url, anonKey } = supabaseConfig();
  const response = await fetch(`${url}/auth/v1/${path}`, {
    method: body === undefined ? "GET" : method || "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || "Authentication failed. Please try again.");
  return data;
}

export async function validSession() {
  let session = getStoredSession();
  if (!session) return null;
  if (session.expires_at && session.expires_at < Math.floor(Date.now() / 1000) + 30) {
    try {
      session = await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
      saveSession(session);
    } catch { saveSession(null); return null; }
  }
  return session;
}
