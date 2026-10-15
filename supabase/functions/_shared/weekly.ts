// The Monday weekly recap push (see sql/launch-2026-10-15.sql): the rules,
// apart from the web request, so they can be tested against a real database.
// Runs hourly; sends to whoever it is Monday 9 AM for, in their own time
// zone, once per week (weekly_recap_sent), and only if they did something
// last week - an empty week gets no push (no guilt trips).
import "./game-rules.js";
import * as pet from "./pet-voice.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Push = (userIds: string[], payload: { title: string; body: string }) => Promise<unknown>;
export type Deps = { admin: Db; push: Push; now: number };

// deno-lint-ignore no-explicit-any
const rules = (globalThis as any).ForjaRules;
const SEND_HOUR = 9;

function localHour(timeZone: string, now: number) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(now)));
}
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 1 = Monday

function distanceText(meters: number, units: unknown) {
  if (meters <= 0) return "";
  return units === "km" ? `${(meters / 1000).toFixed(1)} km` : `${(meters / 1609.344).toFixed(1)} mi`;
}

export async function weeklyRecap({ admin, push, now }: Deps) {
  const { data: subs, error: subsError } = await admin.from("push_subscriptions").select("user_id");
  if (subsError) throw new Error(subsError.message);
  const userIds = [...new Set((subs || []).map((s: { user_id: string }) => s.user_id))];
  if (userIds.length === 0) return { sent: 0 };
  const { data: progress } = await admin.from("user_progress").select("user_id, data").in("user_id", userIds);

  let sent = 0;
  for (const row of progress || []) {
    const zone = row.data?.reminderTimezone;
    if (!rules.isValidTimeZone(zone)) continue;
    const today = rules.localDate(zone, now);
    if (weekday(today) !== 1 || localHour(zone, now) !== SEND_HOUR) continue;
    const week = rules.addDays(today, -7);

    // Claim this week first: a retried run can never send it twice.
    const { error: claimError } = await admin.from("weekly_recap_sent").insert({ user_id: row.user_id, week });
    if (claimError) continue;

    const { data: posts } = await admin
      .from("feed_events")
      .select("kind, day, pushups, plank_seconds, squats, distance_m")
      .eq("user_id", row.user_id)
      .gte("day", week)
      .lte("day", rules.addDays(week, 6));
    const dayPosts = (posts || []).filter((p: { kind: string }) => p.kind === "day");
    const moves = (posts || []).filter((p: { kind: string }) => p.kind === "walk" || p.kind === "run");
    const days = new Set(dayPosts.map((p: { day: string }) => p.day)).size;
    if (days === 0 && moves.length === 0) continue;
    const sum = (list: Record<string, number>[], key: string) => list.reduce((total, p) => total + (Number(p[key]) || 0), 0);

    const { data: league } = await admin.rpc("league_standings_for", { viewer: row.user_id, week_start: week });
    const me = (league || []).find((r: { is_you: boolean }) => r.is_you);
    const place = me && me.points > 0 ? me.place : 0;

    await push(
      [row.user_id],
      pet.weeklyRecap(
        days,
        { pushups: sum(dayPosts, "pushups"), squats: sum(dayPosts, "squats"), plankSeconds: sum(dayPosts, "plank_seconds"), distance: distanceText(sum(moves, "distance_m"), row.data?.units) },
        place,
        (league || []).length,
      ),
    );
    sent++;
  }
  return { sent };
}
