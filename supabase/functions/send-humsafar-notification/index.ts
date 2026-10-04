import { createClient } from "npm:@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5";

type NotificationCategory =
  | "seat_requests"
  | "booking_updates"
  | "driver_status"
  | "trip_reminders";

type NotificationRequest = {
  userId: string;
  title: string;
  body: string;
  category?: NotificationCategory;
  url?: string;
};

type FirebaseServiceAccount = {
  project_id: string;
  private_key: string;
  client_email: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type NotificationSettings = {
  seat_requests: boolean;
  booking_updates: boolean;
  driver_status: boolean;
  trip_reminders: boolean;
};

const VALID_CATEGORIES: NotificationCategory[] = [
  "seat_requests",
  "booking_updates",
  "driver_status",
  "trip_reminders",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-notification-secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getSupabaseServerKey(): string {
  const legacy =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (legacy) return legacy;

  const raw =
    Deno.env.get("SUPABASE_SECRET_KEYS");

  if (!raw) {
    throw new Error(
      "Supabase server secret key is unavailable."
    );
  }

  try {
    const parsed = JSON.parse(raw) as
      | Record<string, string>
      | string[];

    if (Array.isArray(parsed)) {
      const key = parsed.find(
        value =>
          typeof value === "string" &&
          value.length > 0
      );

      if (key) return key;
    } else {
      const key =
        parsed.default ||
        Object.values(parsed).find(
          value =>
            typeof value === "string" &&
            value.length > 0
        );

      if (key) return key;
    }
  } catch {
    if (raw.trim()) return raw.trim();
  }

  throw new Error(
    "Supabase server secret key could not be read."
  );
}

function getFirebaseServiceAccount(): FirebaseServiceAccount {
  const firebaseB64 =
    Deno.env.get("FIREBASE_SERVICE_ACCOUNT_B64");

  if (!firebaseB64) {
    throw new Error(
      "Firebase service account Base64 secret is missing."
    );
  }

  let raw: string;

  try {
    raw = new TextDecoder().decode(
      Uint8Array.from(
        atob(firebaseB64),
        char => char.charCodeAt(0)
      )
    );
  } catch {
    throw new Error(
      "Firebase service account Base64 secret could not be decoded."
    );
  }

  let firebase: FirebaseServiceAccount;

  try {
    firebase =
      JSON.parse(raw) as FirebaseServiceAccount;
  } catch {
    throw new Error(
      "Decoded Firebase service account is not valid JSON."
    );
  }

  if (
    !firebase.project_id ||
    !firebase.private_key ||
    !firebase.client_email
  ) {
    throw new Error(
      "Firebase service account credentials are incomplete."
    );
  }

  return firebase;
}

async function getGoogleAccessToken(
  serviceAccount: FirebaseServiceAccount
): Promise<string> {
  const privateKey = await importPKCS8(
    serviceAccount.private_key,
    "RS256"
  );

  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    scope:
      "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({
      alg: "RS256",
      typ: "JWT",
    })
    .setIssuer(serviceAccount.client_email)
    .setSubject(serviceAccount.client_email)
    .setAudience(
      "https://oauth2.googleapis.com/token"
    )
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    }
  );

  const data =
    (await response.json()) as GoogleTokenResponse;

  if (!response.ok || !data.access_token) {
    console.error(
      "Google OAuth error:",
      data
    );

    throw new Error(
      data.error_description ||
        data.error ||
        "Could not authenticate with Firebase."
    );
  }

  return data.access_token;
}

function validateInput(
  value: unknown
): NotificationRequest {
  if (!value || typeof value !== "object") {
    throw new Error(
      "Invalid notification request."
    );
  }

  const input =
    value as Record<string, unknown>;

  if (
    typeof input.userId !== "string" ||
    !input.userId.trim()
  ) {
    throw new Error(
      "A valid userId is required."
    );
  }

  if (
    typeof input.title !== "string" ||
    !input.title.trim()
  ) {
    throw new Error(
      "A notification title is required."
    );
  }

  if (
    typeof input.body !== "string" ||
    !input.body.trim()
  ) {
    throw new Error(
      "A notification body is required."
    );
  }

  if (
    input.category !== undefined &&
    (
      typeof input.category !== "string" ||
      !VALID_CATEGORIES.includes(
        input.category as NotificationCategory
      )
    )
  ) {
    throw new Error(
      "Invalid notification category."
    );
  }

  return {
    userId: input.userId.trim(),

    title:
      input.title
        .trim()
        .slice(0, 120),

    body:
      input.body
        .trim()
        .slice(0, 500),

    category:
      input.category as
        | NotificationCategory
        | undefined,

    url:
      typeof input.url === "string"
        ? input.url.slice(0, 500)
        : "/",
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (request.method !== "POST") {
    return json(
      { error: "Method not allowed." },
      405
    );
  }

  try {
    /*
     * Only Humsafar's backend is allowed
     * to instruct this function to send.
     */
    const expectedSecret =
      Deno.env.get(
        "HUMSAFAR_NOTIFICATION_SECRET"
      );

    const suppliedSecret =
      request.headers.get(
        "x-notification-secret"
      );

    if (
      !expectedSecret ||
      !suppliedSecret ||
      suppliedSecret !== expectedSecret
    ) {
      return json(
        { error: "Unauthorized." },
        401
      );
    }

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    if (!supabaseUrl) {
      throw new Error(
        "SUPABASE_URL is missing."
      );
    }

    const firebase =
      getFirebaseServiceAccount();

    const supabase = createClient(
      supabaseUrl,
      getSupabaseServerKey(),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    const input =
      validateInput(
        await request.json()
      );

    /*
     * No settings row means defaults = ON.
     */
    if (input.category) {
      const {
        data: settings,
        error: settingsError,
      } = await supabase
        .from("notification_settings")
        .select(
          "seat_requests,booking_updates,driver_status,trip_reminders"
        )
        .eq(
          "user_id",
          input.userId
        )
        .maybeSingle();

      if (settingsError) {
        console.error(
          "Notification settings error:",
          settingsError
        );
      }

      const typedSettings =
        settings as NotificationSettings | null;

      if (
        typedSettings &&
        typedSettings[input.category] === false
      ) {
        return json({
          ok: true,
          skipped: true,
          sent: 0,
          failed: 0,
          reason:
            "Notification category disabled.",
        });
      }
    }

    const {
      data: subscriptions,
      error: subscriptionError,
    } = await supabase
      .from(
        "notification_subscriptions"
      )
      .select(
        "id,device_token"
      )
      .eq(
        "user_id",
        input.userId
      )
      .eq(
        "enabled",
        true
      );

    if (subscriptionError) {
      throw new Error(
        "Could not load notification subscriptions."
      );
    }

    if (!subscriptions?.length) {
      return json({
        ok: true,
        sent: 0,
        failed: 0,
        devices: 0,
        reason:
          "No enabled notification devices.",
      });
    }

    const accessToken =
      await getGoogleAccessToken(
        firebase
      );

    let sent = 0;
    let failed = 0;

    for (
      const subscription
      of subscriptions
    ) {
      try {
        const response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${firebase.project_id}/messages:send`,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              message: {
                token:
                  subscription.device_token,

                notification: {
                  title:
                    input.title,

                  body:
                    input.body,
                },

                data: {
                  url:
                    input.url || "/",

                  category:
                    input.category ||
                    "general",
                },
              },
            }),
          }
        );

        const responseText =
          await response.text();

        if (response.ok) {
          sent++;
          continue;
        }

        failed++;

        console.error(
          "FCM error:",
          responseText
        );

        if (
          responseText.includes(
            "UNREGISTERED"
          ) ||
          responseText.includes(
            "registration-token-not-registered"
          )
        ) {
          await supabase
            .from(
              "notification_subscriptions"
            )
            .update({
              enabled: false,
              updated_at:
                new Date().toISOString(),
            })
            .eq(
              "id",
              subscription.id
            );
        }
      } catch (error) {
        failed++;

        console.error(
          "Device notification error:",
          error
        );
      }
    }

    return json({
      ok: true,
      sent,
      failed,
      devices:
        subscriptions.length,
    });
  } catch (error) {
    console.error(
      "Notification function error:",
      error
    );

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Notification send failed.",
      },
      500
    );
  }
});