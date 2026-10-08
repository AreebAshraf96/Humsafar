export type NotificationCategory =
  | "seat_requests"
  | "booking_updates"
  | "driver_status"
  | "trip_reminders";

export type SendNotificationInput = {
  userId: string;
  title: string;
  body: string;
  category: NotificationCategory;
  url?: string;
};

function config() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL
      ?.replace(/\/$/, "");

  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const secret =
    process.env.HUMSAFAR_NOTIFICATION_SECRET;

  if (
    !supabaseUrl ||
    !anonKey ||
    !secret
  ) {
    return null;
  }

  return {
    supabaseUrl,
    anonKey,
    secret,
  };
}

/*
 * Notification failure must never cause
 * the actual ride/booking action to fail.
 */
export async function sendHumsafarNotification(
  input: SendNotificationInput
): Promise<boolean> {
  const values = config();

  if (!values) {
    console.warn(
      "Notification server configuration is missing."
    );

    return false;
  }

  try {
    const response = await fetch(
      `${values.supabaseUrl}/functions/v1/send-humsafar-notification`,
      {
        method: "POST",

        headers: {
          apikey:
            values.anonKey,

          Authorization:
            `Bearer ${values.anonKey}`,

          "Content-Type":
            "application/json",

          "x-notification-secret":
            values.secret,
        },

        body:
          JSON.stringify({
            userId:
              input.userId,

            title:
              input.title,

            body:
              input.body,

            category:
              input.category,

            url:
              input.url || "/",
          }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      console.error(
        "Notification function failed:",
        response.status,
        await response.text()
      );

      return false;
    }

    return true;
  } catch (error) {
    console.error(
      "Could not send Humsafar notification:",
      error
    );

    return false;
  }
}

export async function sendManyHumsafarNotifications(
  userIds: string[],
  notification: Omit<
    SendNotificationInput,
    "userId"
  >
): Promise<void> {
  const uniqueIds =
    [...new Set(userIds)]
      .filter(Boolean);

  await Promise.allSettled(
    uniqueIds.map(userId =>
      sendHumsafarNotification({
        userId,
        ...notification,
      })
    )
  );
}
