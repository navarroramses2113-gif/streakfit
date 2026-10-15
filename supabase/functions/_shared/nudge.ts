// Friend nudges (see sql/nudges-2026-10-14.sql): the rules, apart from the
// web request around them, so they can be tested against a real database.
// POST { friendId, timeZone } -> { ok: true } or { ok: false, error }.
//
// A nudge only goes out when: you're friends, nobody blocked anybody, the
// friend hasn't trained yet today in THEIR time zone, and you haven't
// nudged them already today. It's saved either way; the pet on their Today
// says who nudged them, and those with notifications on also get a push.
import "./game-rules.js";
import * as pet from "./pet-voice.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Push = (userIds: string[], payload: { title: string; body: string }) => Promise<unknown>;
export type Deps = { admin: Db; push: Push; now: number };
type Reply = { status: number; body: Record<string, unknown> };

// deno-lint-ignore no-explicit-any
const rules = (globalThis as any).ForjaRules;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (body: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...body } });
const no = (error: string, status = 200): Reply => ({ status, body: { ok: false, error } });

export async function nudge({ admin, push, now }: Deps, senderId: string, body: Record<string, unknown>): Promise<Reply> {
  const friendId = body.friendId;
  if (typeof friendId !== "string" || !UUID.test(friendId) || friendId === senderId) return no("bad_friend", 400);

  // Friends, both ways round, and nobody blocked anybody. Either failing
  // gets the same answer, so a nudge can't reveal a block.
  const { data: friendship, error: friendError } = await admin
    .from("friendships")
    .select("id")
    .eq("status", "accepted")
    .or(`and(requester_id.eq.${senderId},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${senderId})`)
    .maybeSingle();
  if (friendError) return no("server_error", 500);
  const { data: blocks, error: blockError } = await admin
    .from("blocked_users")
    .select("blocker_id")
    .or(`and(blocker_id.eq.${senderId},blocked_id.eq.${friendId}),and(blocker_id.eq.${friendId},blocked_id.eq.${senderId})`);
  if (blockError) return no("server_error", 500);
  if (!friendship || (blocks && blocks.length > 0)) return no("not_friends");

  // "Today" is the friend's: their reminder time zone if they set one,
  // otherwise yours (friends are usually near each other), otherwise UTC.
  const { data: progress } = await admin.from("user_progress").select("data").eq("user_id", friendId).maybeSingle();
  const theirZone = progress?.data?.reminderTimezone;
  const zone = rules.isValidTimeZone(theirZone) ? theirZone : rules.isValidTimeZone(body.timeZone) ? body.timeZone : "UTC";
  const day = rules.localDate(zone, now);

  const { data: stats } = await admin
    .from("player_stats")
    .select("streak, best_streak, last_logged_date, rest_days_used, week_start_date")
    .eq("user_id", friendId)
    .maybeSingle();
  if (stats?.last_logged_date && stats.last_logged_date >= day) return no("already_done");

  // The primary key (sender, receiver, day) is the once-a-day rule: a
  // second insert fails, even if two taps race each other.
  const { error: insertError } = await admin.from("nudges").insert({ sender_id: senderId, receiver_id: friendId, day });
  if (insertError) return insertError.code === "23505" ? no("already_nudged") : no("server_error", 500);

  // No notifications set up: the nudge waits in the app instead.
  const { data: subscriptions } = await admin.from("push_subscriptions").select("endpoint").eq("user_id", friendId).limit(1);
  if (!subscriptions || subscriptions.length === 0) return ok();

  const { data: profile } = await admin.from("profiles").select("username").eq("user_id", senderId).maybeSingle();
  // The streak they'd keep by working out today (0 if it's already gone).
  let streak = 0;
  if (stats?.last_logged_date) {
    const next = rules.nextStats(
      { streak: stats.streak, bestStreak: stats.best_streak, lastLoggedDate: stats.last_logged_date, restDaysUsed: stats.rest_days_used, weekStartDate: stats.week_start_date },
      day,
    );
    if (next.streak > 1) streak = stats.streak;
  }
  await push([friendId], pet.nudge(profile?.username || "A friend", friendId, day, streak));
  return ok();
}
