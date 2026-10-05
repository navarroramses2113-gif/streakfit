// Called by a Postgres trigger (set up via SQL, not in this repo's
// migrations) the instant a new row lands in `friendships`, instead of
// waiting for anyone to open the app and happen to check the Competition
// tab. Takes the new row's id and pushes a notification to the addressee.
//
// Each request notifies AT MOST ONCE: the function first claims the row by
// setting friendships.notified_at (a column only the server can write),
// and only sends if that claim succeeded. Calling it again with the same
// id - by the trigger retrying, or by anyone else - sends nothing.
import { createAdminClient } from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  let friendshipId;
  try {
    ({ friendshipId } = await req.json());
  } catch {
    return json({ sent: 0, reason: "bad request" }, 400);
  }
  if (typeof friendshipId !== "string" || !UUID.test(friendshipId)) return json({ sent: 0, reason: "bad request" }, 400);

  const supabaseAdmin = createAdminClient();

  // Atomic claim: only a still-pending request that has never been
  // notified matches, and setting notified_at in the same statement means
  // two calls racing each other can't both get a row back.
  const { data: friendship } = await supabaseAdmin
    .from("friendships")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", friendshipId)
    .eq("status", "pending")
    .is("notified_at", null)
    .select("requester_id, addressee_id")
    .maybeSingle();

  if (!friendship) return json({ sent: 0, reason: "nothing to notify" });

  const { data: requesterProfile } = await supabaseAdmin
    .from("profiles")
    .select("username")
    .eq("user_id", friendship.requester_id)
    .maybeSingle();

  const requesterName = requesterProfile ? requesterProfile.username : "Someone";

  const result = await sendPushToUsers(supabaseAdmin, [friendship.addressee_id], {
    title: "Forja",
    body: `${requesterName} wants to be your friend!`,
  });

  return json({ sent: result.sent });
});
