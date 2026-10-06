// Posts a finished walk or run to the caller's Feed. The phone sends the
// GPS points and the moving time; the distance, the pace and whether it
// was a walk or a run are worked out here, from the points, never taken
// from the phone. GPS can be faked, so this is a realistic-speed check
// rather than proof - walks and runs don't affect the leaderboard streak.
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
  const { day, points, durationMs } = body ?? {};
  if (!rules.dayInRange(day, Date.now())) return json({ ok: false, error: "bad_day" }, 400);

  const activity = rules.checkActivity(points, durationMs);
  if (!activity.ok) return json({ ok: false, error: activity.error }, 422);

  const admin = createAdminClient();
  const { count, error: countError } = await admin
    .from("feed_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("day", day)
    .in("kind", ["walk", "run"]);
  if (countError) return json({ ok: false, error: "server_error" }, 500);
  if ((count ?? 0) >= rules.ACTIVITY.MAX_PER_DAY) return json({ ok: false, error: "daily_limit" }, 429);

  const { error: insertError } = await admin.from("feed_events").insert({
    user_id: user.id,
    day,
    kind: activity.kind,
    distance_m: activity.distanceM,
    duration_s: activity.durationS,
  });
  if (insertError) return json({ ok: false, error: "server_error" }, 500);

  return json({ ok: true, kind: activity.kind, distanceM: activity.distanceM, durationS: activity.durationS });
});
