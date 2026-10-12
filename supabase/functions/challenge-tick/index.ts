// Runs every 15 minutes (set up via pg_cron - see challenges-2026-10-09.sql).
// Starts challenges whose day 1 has begun (or cancels them if nobody
// joined), saves each player's finished days, puts people out, tells
// people they've been passed, and ends challenges with places, Feed posts
// and result notifications.
//
// Only the schedule may run it (isInternalCall). Even so, every step is
// claimed or checked in the database first, so an extra call never does
// anything the schedule wouldn't have done anyway.
import { createAdminClient, isInternalCall } from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";
import { tick } from "../_shared/challenges.ts";

Deno.serve(async (req) => {
  const admin = createAdminClient();
  if (!(await isInternalCall(req, admin))) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const push = async (userIds: string[], payload: { title: string; body: string }) => {
    try {
      await sendPushToUsers(admin, userIds, payload);
    } catch (err) {
      console.error("challenge push failed", String((err as Error).message ?? err));
    }
  };

  try {
    const result = await tick({ admin, push, now: Date.now() });
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("challenge tick failed", String((err as Error).message ?? err));
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
  }
});
