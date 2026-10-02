// Called by a Postgres trigger (set up via SQL, not in this repo's
// migrations) the instant a new row lands in `friendships`, instead of
// waiting for anyone to open the app and happen to check the Competition
// tab. Takes the new row's id and pushes a notification to the addressee.
import { createAdminClient } from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";

Deno.serve(async (req) => {
  const { friendshipId } = await req.json();
  const supabaseAdmin = createAdminClient();

  const { data: friendship } = await supabaseAdmin
    .from("friendships")
    .select("requester_id, addressee_id")
    .eq("id", friendshipId)
    .maybeSingle();

  if (!friendship) {
    return new Response(JSON.stringify({ sent: 0, reason: "friendship not found" }), { status: 404 });
  }

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

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
});
