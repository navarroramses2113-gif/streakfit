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
type Text = { title: string; body: string };
// pet-voice.ts messages carry their Spanish as `es`.
type Payload = Text & { es?: Text };

// The message in one person's language: the app saves "es" in their data
// when it's used in Spanish; anything else gets English.
export function inLanguage(payload: Payload, language: unknown): Text {
  if (language === "es" && payload.es) return payload.es;
  return { title: payload.title, body: payload.body };
}

// Each user's app language, read from their saved data (user_progress).
// Unreadable: everyone gets English, as before.
async function languagesOf(supabaseAdmin: ReturnType<typeof createClient>, userIds: string[]) {
  const { data, error } = await supabaseAdmin.from("user_progress").select("user_id, language:data->>language").in("user_id", userIds);
  if (error || !data) return new Map<string, unknown>();
  return new Map((data as { user_id: string; language: unknown }[]).map((row) => [row.user_id, row.language]));
}

// Sends one notification to each given subscription, cleaning up any the
// push service reports as dead (404/410 - uninstalled, permission revoked,
// etc.) instead of retrying them forever. Returns which endpoints got it.
// (A payload with Spanish attached goes out in English here; pick the
// language first with inLanguage.)
export async function sendPushToSubscriptions(
  supabaseAdmin: ReturnType<typeof createClient>,
  subscriptions: Subscription[],
  payload: Payload
) {
  const sentEndpoints: string[] = [];
  const expiredEndpoints: string[] = [];
  const message = inLanguage(payload, "en");

  await Promise.all(
    subscriptions.filter((sub) => isKnownPushService(sub.endpoint)).map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } }, JSON.stringify(message));
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

// Sends one notification to every subscription belonging to the given
// users, each in their own app language.
export async function sendPushToUsers(
  supabaseAdmin: ReturnType<typeof createClient>,
  userIds: string[],
  payload: Payload
) {
  if (userIds.length === 0) return { sent: 0, sentEndpoints: [], expiredRemoved: 0 };

  const { data: subscriptions } = await supabaseAdmin
    .from("push_subscriptions")
    .select("endpoint, user_id, p256dh, auth_key")
    .in("user_id", userIds);
  const subs = (subscriptions || []) as (Subscription & { user_id: string })[];

  // Only messages with Spanish attached need the lookup.
  const languages = payload.es ? await languagesOf(supabaseAdmin, userIds) : new Map<string, unknown>();
  const spanish = subs.filter((sub) => languages.get(sub.user_id) === "es");
  const english = subs.filter((sub) => languages.get(sub.user_id) !== "es");

  const result = { sent: 0, sentEndpoints: [] as string[], expiredRemoved: 0 };
  for (const [group, language] of [[english, "en"], [spanish, "es"]] as const) {
    if (group.length === 0) continue;
    const sent = await sendPushToSubscriptions(supabaseAdmin, group, inLanguage(payload, language));
    result.sent += sent.sent;
    result.sentEndpoints.push(...sent.sentEndpoints);
    result.expiredRemoved += sent.expiredRemoved;
  }
  return result;
}
