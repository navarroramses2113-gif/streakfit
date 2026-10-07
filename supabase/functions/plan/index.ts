// The caller's progressive overload plan. POST {} returns it (starting one
// from their current minimums if they don't have one yet); POST { pace }
// changes their pace - the one part of the plan a player chooses. Targets
// themselves only ever change through log-day.
import "../_shared/game-rules.js";
import { authenticate, corsHeaders, createAdminClient, json } from "../_shared/http.ts";
import { loadOrCreatePlan, savePlan } from "../_shared/plan.ts";

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
    body = {};
  }
  const { pace } = body ?? {};
  if (pace !== undefined && !Object.hasOwn(rules.PLAN_RULES.paces, pace)) return json({ ok: false, error: "bad_pace" }, 400);

  const admin = createAdminClient();
  const plan = await loadOrCreatePlan(admin, user.id);
  if (!plan) return json({ ok: false, error: "server_error" }, 500);

  if (pace !== undefined && pace !== plan.pace) {
    plan.pace = pace;
    if (!(await savePlan(admin, user.id, plan))) return json({ ok: false, error: "server_error" }, 500);
  }
  return json({ ok: true, plan });
});
