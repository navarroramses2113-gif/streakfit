// Runs hourly (set up via pg_cron in Supabase's SQL editor, not in this
// file - was once-daily before per-user reminder times existed). Each run
// checks every user's OWN chosen local hour against the current time in
// their OWN timezone, and only sends to the ones where it actually
// matches right now, plus hasn't logged a workout yet today.
import { createAdminClient } from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";

Deno.serve(async (req) => {
  const supabaseAdmin = createAdminClient();
  const now = new Date();

  const { data: progressRows, error: progressError } = await supabaseAdmin
    .from("user_progress")
    .select("user_id, data");

  if (progressError) {
    return new Response(JSON.stringify({ error: progressError.message }), { status: 500 });
  }

  const dueUserIds = (progressRows || [])
    .filter((row) => {
      const d = row.data || {};
      // Never turned reminders on (or on an old account from before this
      // field existed, which hasn't re-saved yet) - nothing to send.
      if (!d.reminderTimezone) return false;

      const targetHour = d.reminderHour ?? 19;
      // hourCycle: "h23" (not hour12: false) specifically to avoid a real
      // Intl quirk where midnight can format as "24" instead of "0" in
      // some environments, which would make the "0" hour unreachable.
      const localHour = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: d.reminderTimezone, hour: "numeric", hourCycle: "h23" }).format(now)
      );
      if (localHour !== targetHour) return false;

      // Compares against "today" in THIS user's own timezone, not a
      // single shared UTC day - two people in different timezones can
      // disagree on what day it currently is.
      const localDateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: d.reminderTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);

      return d.lastLoggedDate !== localDateStr;
    })
    .map((row) => row.user_id);

  const result = await sendPushToUsers(supabaseAdmin, dueUserIds, {
    title: "Forja",
    body: "You haven't logged your workout today - don't let your streak slip!",
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
});
