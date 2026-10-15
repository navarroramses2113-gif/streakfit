// Runs hourly (pg_cron, see sql/launch-2026-10-15.sql); sends the Monday
// 9 AM weekly recap push. Only the schedule may call it (isInternalCall).
// The rules live in _shared/weekly.ts.
import { createAdminClient, isInternalCall } from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";
import { weeklyRecap } from "../_shared/weekly.ts";

Deno.serve(async (req) => {
  const admin = createAdminClient();
  if (!(await isInternalCall(req, admin))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const push = async (userIds: string[], payload: { title: string; body: string }) => {
    try {
      await sendPushToUsers(admin, userIds, payload);
    } catch (err) {
      console.error("weekly recap push failed", String((err as Error).message ?? err));
    }
  };
  try {
    const result = await weeklyRecap({ admin, push, now: Date.now() });
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("weekly recap failed", String((err as Error).message ?? err));
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
  }
});
