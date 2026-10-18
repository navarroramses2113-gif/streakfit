// The front page's waitlist (see sql/waitlist-founders-2026-10-18.sql): the
// rules, apart from the web request around them, so they can be tested
// against a real database. No account needed.
// POST { action: "join", email, ref?, src? } -> { ok, code, place, referrals, total }
//   (ref = the friend's code from their ?r= link; src = ?src=tiktok etc.)
// POST { action: "status", code } -> { ok, place, referrals, total }
//   (the page keeps your code on your phone and asks again on a later visit)

// deno-lint-ignore no-explicit-any
type Db = any;
export type Deps = { admin: Db; allJoinsPer10Min?: number };
type Reply = { status: number; body: Record<string, unknown> };

const CODE = /^[a-z0-9]{8}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
// Letters and digits that can't be mistaken for each other (no 0/o, 1/l/i).
const CODE_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789";
// Joins from one machine (scrambled IP) per hour.
export const JOINS_PER_HOUR = 5;
// Joins from everyone together per 10 minutes: a ceiling for a bot that
// fakes its address. A real rush this big is a good problem - raise it.
export const ALL_JOINS_PER_10_MIN = 600;

const ok = (body: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...body } });
const no = (error: string, status = 200): Reply => ({ status, body: { ok: false, error } });

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
}

async function placeOf(admin: Db, code: string) {
  const { data, error } = await admin.rpc("waitlist_place", { code });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { place: Number(row.place), referrals: Number(row.referrals), total: Number(row.total) } : null;
}

export async function waitlist({ admin, allJoinsPer10Min = ALL_JOINS_PER_10_MIN }: Deps, ipHash: string | null, body: Record<string, unknown>): Promise<Reply> {
  if (body.action === "status") {
    const code = typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
    if (!CODE.test(code)) return no("bad_code", 400);
    const place = await placeOf(admin, code);
    return place ? ok(place) : no("unknown_code");
  }
  if (body.action !== "join") return no("bad_action", 400);

  // A hidden field people never see; a bot filling every box fills it too.
  if (typeof body.website === "string" && body.website !== "") return no("bad_request", 400);

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length < 6 || email.length > 254 || !EMAIL.test(email)) return no("bad_email", 400);
  const ref = typeof body.ref === "string" && CODE.test(body.ref.trim().toLowerCase()) ? body.ref.trim().toLowerCase() : null;
  const source = typeof body.src === "string" ? body.src.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || null : null;

  if (ipHash) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent, error } = await admin.from("waitlist").select("id").eq("ip_hash", ipHash).gte("created_at", since);
    if (error) return no("server_error", 500);
    if ((recent || []).length >= JOINS_PER_HOUR) return no("too_many", 429);
  }

  {
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: rush, error } = await admin.from("waitlist").select("id").gte("created_at", since).limit(allJoinsPer10Min);
    if (error) return no("server_error", 500);
    if ((rush || []).length >= allJoinsPer10Min) return no("busy", 429);
  }

  // Already on it: say so, but never hand out that person's code or place.
  const { data: existing, error: existingError } = await admin.from("waitlist").select("id").eq("email", email).maybeSingle();
  if (existingError) return no("server_error", 500);
  if (existing) return no("already_joined");

  // A friend's link counts unless it comes from the same machine as the
  // friend (someone signing up their own spare emails).
  let referredBy: string | null = null;
  if (ref) {
    const { data: friend } = await admin.from("waitlist").select("ref_code, ip_hash").eq("ref_code", ref).maybeSingle();
    if (friend && !(ipHash && friend.ip_hash === ipHash)) referredBy = friend.ref_code;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newCode();
    const { error } = await admin.from("waitlist").insert({ email, ref_code: code, referred_by: referredBy, source, ip_hash: ipHash });
    if (!error) {
      const place = await placeOf(admin, code);
      return ok({ code, ...(place || {}) });
    }
    // Two taps at once: the email is already in.
    if (error.code === "23505" && /email/.test(`${error.message} ${error.details ?? ""}`)) return no("already_joined");
    // A code that's taken (about one in a trillion): try another.
    if (error.code !== "23505") return no("server_error", 500);
  }
  return no("server_error", 500);
}
