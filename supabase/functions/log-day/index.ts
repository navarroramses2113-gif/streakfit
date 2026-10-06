// Logs a day for the caller if - and only if - the server's own record of
// their verified sets meets the minimums, then advances their streak and
// posts the day to their friends' Feed. The streak lives in player_stats
// and posts in feed_events; only this function can write either.
import "../_shared/game-rules.js";
import { authenticate, corsHeaders, createAdminClient, json } from "../_shared/http.ts";

// deno-lint-ignore no-explicit-any
const rules = (globalThis as any).ForjaRules;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const user = await authenticate(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const { day } = body ?? {};
  if (!rules.dayInRange(day, Date.now())) return json({ ok: false, error: "bad_day" }, 400);

  const admin = createAdminClient();

  const { data: row, error: statsError } = await admin.from("player_stats").select("*").eq("user_id", user.id).maybeSingle();
  if (statsError) return json({ ok: false, error: "server_error" }, 500);

  const current = {
    streak: row?.streak ?? 0,
    bestStreak: row?.best_streak ?? 0,
    lastLoggedDate: row?.last_logged_date ?? null,
    restDaysUsed: row?.rest_days_used ?? 0,
    weekStartDate: row?.week_start_date ?? null,
  };

  // A day can be logged once, and never before one already logged.
  if (current.lastLoggedDate && rules.daysBetween(current.lastLoggedDate, day) <= 0) {
    return json({ ok: false, error: "already_logged", stats: current });
  }

  const { data: sets, error: setsError } = await admin
    .from("verified_sets")
    .select("exercise, value")
    .eq("user_id", user.id)
    .eq("day", day);
  if (setsError) return json({ ok: false, error: "server_error" }, 500);

  const totals = rules.totalsFromSets(sets);
  const missing = rules.shortfalls(totals);
  if (missing.length > 0) return json({ ok: false, error: "below_minimum", missing, totals, floors: rules.FLOORS });

  const next = rules.nextStats(current, day);
  const { error: saveError } = await admin.from("player_stats").upsert({
    user_id: user.id,
    streak: next.streak,
    best_streak: next.bestStreak,
    last_logged_date: next.lastLoggedDate,
    rest_days_used: next.restDaysUsed,
    week_start_date: next.weekStartDate,
    updated_at: new Date().toISOString(),
  });
  if (saveError) return json({ ok: false, error: "server_error" }, 500);

  // Share the day with friends. The day is already logged at this point, so
  // a Feed hiccup must never turn into an error for the player. Cardio
  // minutes come from the walk/run posts the server itself recorded today.
  const { data: activities } = await admin
    .from("feed_events")
    .select("duration_s")
    .eq("user_id", user.id)
    .eq("day", day)
    .in("kind", ["walk", "run"]);
  const cardioMinutes = Math.round((activities ?? []).reduce((sum, a) => sum + a.duration_s, 0) / 60);
  const { error: feedError } = await admin.from("feed_events").insert(rules.feedPost(user.id, day, totals, current, next, cardioMinutes));
  // 23505 = this day already has its post (only one per day is allowed).
  if (feedError && feedError.code !== "23505") console.error("feed post failed", feedError.message);

  return json({ ok: true, stats: next });
});
