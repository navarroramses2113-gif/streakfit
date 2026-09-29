// Runs on a schedule (set up via pg_cron in Supabase's SQL editor, not in
// this file). Checks who hasn't logged a workout today and sends each of
// them a push notification via Web Push.
//
// Uses the SERVICE ROLE key, not the anon key the rest of the app uses -
// this bypasses every RLS policy, which is exactly what's needed here
// (checking every user's data, not just one signed-in person's). That key
// only lives in this function's environment (set via `supabase secrets
// set`), never in script.js or anywhere else client-side.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;

webpush.setVapidDetails("mailto:navarroramses2113@gmail.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // "Today" in UTC. A deliberate simplification: everyone is checked
  // against the same calendar day regardless of their own timezone, so
  // this can fire a little early or late for someone outside it. Fine for
  // a small group of testers in nearby timezones; a per-user timezone
  // column would be the real fix if this ever needs to be precise.
  const today = new Date().toISOString().slice(0, 10);

  const { data: progressRows, error: progressError } = await supabaseAdmin
    .from("user_progress")
    .select("user_id, data");

  if (progressError) {
    return new Response(JSON.stringify({ error: progressError.message }), { status: 500 });
  }

  const usersNotLoggedToday = (progressRows || [])
    .filter((row) => !row.data || row.data.lastLoggedDate !== today)
    .map((row) => row.user_id);

  if (usersNotLoggedToday.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: "everyone already logged today" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: subscriptions, error: subsError } = await supabaseAdmin
    .from("push_subscriptions")
    .select("endpoint, user_id, p256dh, auth_key")
    .in("user_id", usersNotLoggedToday);

  if (subsError) {
    return new Response(JSON.stringify({ error: subsError.message }), { status: 500 });
  }

  let sent = 0;
  const expiredEndpoints: string[] = [];

  await Promise.all(
    (subscriptions || []).map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth_key },
      };

      try {
        await webpush.sendNotification(
          pushSubscription,
          JSON.stringify({
            title: "Forja",
            body: "You haven't logged your workout today - don't let your streak slip!",
          })
        );
        sent++;
      } catch (err) {
        // 404/410 means the browser or OS has invalidated this
        // subscription (uninstalled, permissions revoked, etc.) - clean
        // it up instead of retrying it forever.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          expiredEndpoints.push(sub.endpoint);
        }
      }
    })
  );

  if (expiredEndpoints.length > 0) {
    await supabaseAdmin.from("push_subscriptions").delete().in("endpoint", expiredEndpoints);
  }

  return new Response(JSON.stringify({ sent, expiredRemoved: expiredEndpoints.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
