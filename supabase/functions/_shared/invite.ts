// Invite links (see sql/launch-2026-10-15.sql): the rules, apart from the
// web request around them, so they can be tested against a real database.
// POST { action: "peek", code } -> { ok, name, color } (no login needed:
//   the welcome screen says who invited you before you have an account)
// POST { action: "accept", code } -> { ok, name } (signed in): you and the
//   link's owner are friends from now on, no request to accept.
import * as pet from "./pet-voice.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Push = (userIds: string[], payload: { title: string; body: string }) => Promise<unknown>;
export type Deps = { admin: Db; push: Push };
type Reply = { status: number; body: Record<string, unknown> };

const CODE = /^[a-f0-9]{10}$/;
const ok = (body: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...body } });
const no = (error: string, status = 200): Reply => ({ status, body: { ok: false, error } });

export async function invite({ admin, push }: Deps, callerId: string | null, body: Record<string, unknown>): Promise<Reply> {
  const code = typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
  if (!CODE.test(code)) return no("bad_code", 400);
  if (body.action !== "peek" && body.action !== "accept") return no("bad_action", 400);

  const { data: owner, error: ownerError } = await admin.from("invite_codes").select("user_id").eq("code", code).maybeSingle();
  if (ownerError) return no("server_error", 500);
  if (!owner) return no("unknown_code");
  const { data: profile } = await admin.from("profiles").select("username, avatar_color").eq("user_id", owner.user_id).maybeSingle();
  if (!profile) return no("unknown_code");
  if (body.action === "peek") return ok({ name: profile.username, color: profile.avatar_color });

  if (!callerId) return no("unauthorized", 401);
  if (owner.user_id === callerId) return no("own_code");
  // Friends are shown by username, so you need one first (sign-up picks it).
  const { data: me } = await admin.from("profiles").select("username").eq("user_id", callerId).maybeSingle();
  if (!me) return no("no_username");

  // A block either way: the same answer as a code that doesn't exist, so a
  // link can't reveal a block.
  const { data: blocks, error: blockError } = await admin
    .from("blocked_users")
    .select("blocker_id")
    .or(`and(blocker_id.eq.${callerId},blocked_id.eq.${owner.user_id}),and(blocker_id.eq.${owner.user_id},blocked_id.eq.${callerId})`);
  if (blockError) return no("server_error", 500);
  if (blocks && blocks.length > 0) return no("unknown_code");

  const { data: rows, error: rowsError } = await admin
    .from("friendships")
    .select("id, status")
    .or(`and(requester_id.eq.${callerId},addressee_id.eq.${owner.user_id}),and(requester_id.eq.${owner.user_id},addressee_id.eq.${callerId})`);
  if (rowsError) return no("server_error", 500);
  if ((rows || []).some((r: { status: string }) => r.status === "accepted")) return ok({ name: profile.username, already: true });

  const pending = (rows || []).find((r: { status: string }) => r.status === "pending");
  if (pending) {
    const { error } = await admin.from("friendships").update({ status: "accepted" }).eq("id", pending.id);
    if (error) return no("server_error", 500);
  } else {
    // From the one who joined: it counts against THEIR hourly request limit,
    // not the link owner's (a popular link would hit it). Already accepted,
    // so no "wants in" push goes out.
    const { error } = await admin.from("friendships").insert({ requester_id: callerId, addressee_id: owner.user_id, status: "accepted" });
    if (error) return no("server_error", 500);
  }
  await push([owner.user_id], pet.inviteJoined(me.username));
  return ok({ name: profile.username });
}
