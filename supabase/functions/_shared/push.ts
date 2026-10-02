// Shared by every Edge Function that sends a Web Push notification
// (send-reminders, notify-friend-request, and any future one). Files
// under _shared/ aren't deployed as their own endpoints - they're just
// importable modules, same as any other local module.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

webpush.setVapidDetails(
  "mailto:navarroramses2113@gmail.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!
);

// Sends one notification to every subscription belonging to the given
// users, cleaning up any subscription the push service reports as dead
// (404/410 - uninstalled, permission revoked, etc.) instead of retrying
// it forever.
export async function sendPushToUsers(
  supabaseAdmin: ReturnType<typeof createClient>,
  userIds: string[],
  payload: { title: string; body: string }
) {
  if (userIds.length === 0) return { sent: 0, expiredRemoved: 0 };

  const { data: subscriptions } = await supabaseAdmin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .in("user_id", userIds);

  let sent = 0;
  const expiredEndpoints: string[] = [];

  await Promise.all(
    (subscriptions || []).map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth_key },
      };

      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
        sent++;
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          expiredEndpoints.push(sub.endpoint);
        }
      }
    })
  );

  if (expiredEndpoints.length > 0) {
    await supabaseAdmin.from("push_subscriptions").delete().in("endpoint", expiredEndpoints);
  }

  return { sent, expiredRemoved: expiredEndpoints.length };
}
