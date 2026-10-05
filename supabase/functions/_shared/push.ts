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

// A subscription's endpoint is a URL the browser gave us, but it's stored
// in a table people write to themselves - so only ever send to the real
// browser push services, never to whatever address someone saved.
const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_SERVICE_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

export function isKnownPushService(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    return PUSH_SERVICE_HOSTS.includes(url.hostname) || PUSH_SERVICE_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

type Subscription = { endpoint: string; p256dh: string; auth_key: string };

// Sends one notification to each given subscription, cleaning up any the
// push service reports as dead (404/410 - uninstalled, permission revoked,
// etc.) instead of retrying them forever. Returns which endpoints got it.
export async function sendPushToSubscriptions(
  supabaseAdmin: ReturnType<typeof createClient>,
  subscriptions: Subscription[],
  payload: { title: string; body: string }
) {
  const sentEndpoints: string[] = [];
  const expiredEndpoints: string[] = [];

  await Promise.all(
    subscriptions.filter((sub) => isKnownPushService(sub.endpoint)).map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } }, JSON.stringify(payload));
        sentEndpoints.push(sub.endpoint);
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

  return { sent: sentEndpoints.length, sentEndpoints, expiredRemoved: expiredEndpoints.length };
}

// Sends one notification to every subscription belonging to the given users.
export async function sendPushToUsers(
  supabaseAdmin: ReturnType<typeof createClient>,
  userIds: string[],
  payload: { title: string; body: string }
) {
  if (userIds.length === 0) return { sent: 0, sentEndpoints: [], expiredRemoved: 0 };

  const { data: subscriptions } = await supabaseAdmin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .in("user_id", userIds);

  return sendPushToSubscriptions(supabaseAdmin, subscriptions || [], payload);
}
