// Loading and saving a player's progressive overload plan (player_plans).
// The rules themselves live in game-rules.js; this file only moves plans
// between the database and those rules.
import "./game-rules.js";
import { createClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
const rules = (globalThis as any).ForjaRules;

// The player's plan. Someone who has never had one (everyone, the first
// time) gets one started from the fixed minimums they already had, at the
// Regular pace - so nobody's day gets harder overnight. Returns null if the
// database can't be reached.
export async function loadOrCreatePlan(admin: ReturnType<typeof createClient>, userId: string) {
  const { data: row, error } = await admin.from("player_plans").select("*").eq("user_id", userId).maybeSingle();
  if (error) return null;
  if (row) return rules.planFromRow(row);

  const { data: progress } = await admin.from("user_progress").select("data").eq("user_id", userId).maybeSingle();
  const fresh = rules.planFromMinimums(progress?.data?.minimums);
  // ignoreDuplicates: if two requests create it at once, the first one wins.
  const { error: insertError } = await admin
    .from("player_plans")
    .upsert(rules.planToRow(userId, fresh), { onConflict: "user_id", ignoreDuplicates: true });
  if (insertError) return null;
  const { data: saved } = await admin.from("player_plans").select("*").eq("user_id", userId).maybeSingle();
  return saved ? rules.planFromRow(saved) : null;
}

export async function savePlan(admin: ReturnType<typeof createClient>, userId: string, plan: unknown) {
  const { error } = await admin
    .from("player_plans")
    .upsert({ ...rules.planToRow(userId, plan), updated_at: new Date().toISOString() });
  return !error;
}
