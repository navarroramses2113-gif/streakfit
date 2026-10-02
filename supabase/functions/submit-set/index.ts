// Receives the recorded movement of one camera set, recounts it with the
// same code the phone used, and saves ONLY what that recount says. There
// is deliberately no field for the client to claim a count - the number
// that gets saved is the server's own.
import "../_shared/exercise-counter.js";
import "../_shared/game-rules.js";
import { authenticate, corsHeaders, createAdminClient, json } from "../_shared/http.ts";

// deno-lint-ignore no-explicit-any
const { recountTrace } = (globalThis as any).ForjaCounter;
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
  const { trace, day } = body ?? {};

  if (!rules.dayInRange(day, Date.now())) return json({ ok: false, error: "bad_day" }, 400);

  let recount;
  try {
    recount = recountTrace(trace);
  } catch (err) {
    return json({ ok: false, error: "bad_trace", detail: String(err.message ?? err) }, 400);
  }
  if (!recount.plausible) return json({ ok: false, error: "implausible" }, 422);

  // Nothing countable - not an error, just nothing to save.
  if (recount.value <= 0) return json({ ok: true, value: 0 });

  const admin = createAdminClient();
  const { data: existing, error: readError } = await admin
    .from("verified_sets")
    .select("exercise, value")
    .eq("user_id", user.id)
    .eq("day", day);
  if (readError) return json({ ok: false, error: "server_error" }, 500);

  if (existing.length >= rules.MAX_SETS_PER_DAY) return json({ ok: false, error: "too_many_sets" }, 429);

  const key = recount.exercise === "pushup" ? "pushups" : recount.exercise === "squat" ? "squats" : null;
  if (key) {
    const doneToday = existing.filter((s) => s.exercise === recount.exercise).reduce((sum, s) => sum + s.value, 0);
    if (doneToday + recount.value > rules.MAX_REPS_PER_DAY[key]) return json({ ok: false, error: "daily_limit" }, 429);
  }

  const { error: insertError } = await admin
    .from("verified_sets")
    .insert({ user_id: user.id, exercise: recount.exercise, value: recount.value, day });
  if (insertError) return json({ ok: false, error: "server_error" }, 500);

  return json({ ok: true, value: recount.value });
});
