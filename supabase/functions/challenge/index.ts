// Friend challenges, for the app. POST { action, ... }:
//   list    { timeZone }                       -> invites, challenges, trophies
//   create  { type, exercise | days | speed + climb, friendIds, timeZone }
//   respond { challengeId, accept, timeZone }
//   seen    { challengeId }                    -> results screen shown
// Everything a player does with a challenge goes through here; the
// challenge tables can't be read or written from the app directly.
import { authenticate, corsHeaders, createAdminClient, json } from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";
import { handle } from "../_shared/challenges.ts";

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

  const admin = createAdminClient();
  // A notification that can't be sent never fails the request.
  const push = async (userIds: string[], payload: { title: string; body: string }) => {
    try {
      await sendPushToUsers(admin, userIds, payload);
    } catch (err) {
      console.error("challenge push failed", String((err as Error).message ?? err));
    }
  };

  try {
    const reply = await handle({ admin, push, now: Date.now() }, user.id, body ?? {});
    return json(reply.body, reply.status);
  } catch (err) {
    console.error("challenge failed", String((err as Error).message ?? err));
    return json({ ok: false, error: "server_error" }, 500);
  }
});
