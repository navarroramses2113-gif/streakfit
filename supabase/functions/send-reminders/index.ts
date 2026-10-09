// Runs hourly (set up via pg_cron in Supabase's SQL editor, not in this
// file). Each run checks every user's OWN chosen local hour against the
// current time in their OWN timezone, and only sends to the ones where it
// actually matches right now, plus hasn't logged a workout yet today.
//
// Each device gets at most one reminder per local day (tracked in
// push_subscriptions.last_reminded_on, which only the server can write),
// so calling this function again - by the cron job retrying, or by anyone
// else - can never turn into a flood of reminders.
import "../_shared/game-rules.js";
import { createAdminClient } from "../_shared/http.ts";
import * as pet from "../_shared/pet-voice.ts";
import { sendPushToSubscriptions } from "../_shared/push.ts";

// deno-lint-ignore no-explicit-any
const rules = (globalThis as any).ForjaRules;

// The user's local hour and date right now, or null if their saved
// timezone isn't a real one. Progress data is written by the users
// themselves, so one bad value must skip that person - not crash the run
// for everyone.
function localNow(timeZone: string, now: Date) {
  try {
    // hourCycle: "h23" (not hour12: false) avoids an Intl quirk where
    // midnight can format as "24", which would make hour 0 unreachable.
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
    const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return { hour, date };
  } catch {
    return null;
  }
}

Deno.serve(async () => {
  const supabaseAdmin = createAdminClient();
  const now = new Date();

  const { data: progressRows, error: progressError } = await supabaseAdmin.from("user_progress").select("user_id, data");
  if (progressError) {
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
  }

  // user_id -> that user's local date, for everyone due a reminder now.
  const dueDateByUser = new Map<string, string>();
  for (const row of progressRows || []) {
    const d = row.data || {};
    // Never turned reminders on - nothing to send.
    if (typeof d.reminderTimezone !== "string") continue;
    const local = localNow(d.reminderTimezone, now);
    if (!local) continue;
    const targetHour = Number.isInteger(d.reminderHour) ? d.reminderHour : 19;
    if (local.hour !== targetHour) continue;
    // "Today" in THIS user's own timezone, not one shared UTC day.
    if (d.lastLoggedDate === local.date) continue;
    dueDateByUser.set(row.user_id, local.date);
  }

  if (dueDateByUser.size === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const { data: subscriptions, error: subsError } = await supabaseAdmin
    .from("push_subscriptions")
    .select("endpoint, user_id, p256dh, auth_key, last_reminded_on")
    .in("user_id", [...dueDateByUser.keys()]);
  if (subsError) {
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
  }

  // Skip any device already reminded today.
  const pending = (subscriptions || []).filter((sub) => sub.last_reminded_on !== dueDateByUser.get(sub.user_id));

  // The pet mentions the streak they'd keep by working out today - 0 when
  // it's already gone (more missed days than the week's rest days cover).
  // If streaks can't be read, the reminder still goes out, just without one.
  const { data: statsRows } = await supabaseAdmin
    .from("player_stats")
    .select("user_id, streak, best_streak, last_logged_date, rest_days_used, week_start_date")
    .in("user_id", [...dueDateByUser.keys()]);
  const liveStreak = new Map<string, number>();
  for (const row of statsRows || []) {
    const stats = {
      streak: row.streak ?? 0,
      bestStreak: row.best_streak ?? 0,
      lastLoggedDate: row.last_logged_date ?? null,
      restDaysUsed: row.rest_days_used ?? 0,
      weekStartDate: row.week_start_date ?? null,
    };
    const keeps = stats.lastLoggedDate && rules.nextStats(stats, dueDateByUser.get(row.user_id)).streak > 1;
    liveStreak.set(row.user_id, keeps ? stats.streak : 0);
  }

  // One message per person (each gets their own line), sent to all their devices.
  const result = { sent: 0, sentEndpoints: [] as string[], expiredRemoved: 0 };
  for (const userId of new Set(pending.map((sub) => sub.user_id))) {
    const message = pet.reminder(userId, dueDateByUser.get(userId)!, liveStreak.get(userId) ?? 0);
    const sent = await sendPushToSubscriptions(supabaseAdmin, pending.filter((sub) => sub.user_id === userId), message);
    result.sent += sent.sent;
    result.sentEndpoints.push(...sent.sentEndpoints);
    result.expiredRemoved += sent.expiredRemoved;
  }

  // Record the reminder per local date (users in different timezones can be
  // on different dates at the same moment).
  const endpointsByDate = new Map<string, string[]>();
  for (const sub of pending) {
    if (!result.sentEndpoints.includes(sub.endpoint)) continue;
    const date = dueDateByUser.get(sub.user_id)!;
    endpointsByDate.set(date, [...(endpointsByDate.get(date) || []), sub.endpoint]);
  }
  for (const [date, endpoints] of endpointsByDate) {
    await supabaseAdmin.from("push_subscriptions").update({ last_reminded_on: date }).in("endpoint", endpoints);
  }

  return new Response(JSON.stringify({ sent: result.sent, expiredRemoved: result.expiredRemoved }), {
    headers: { "Content-Type": "application/json" },
  });
});
