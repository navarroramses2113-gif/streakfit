// The front page's waitlist. No account needed. The rules live in
// _shared/waitlist.ts.
import { corsHeaders, createAdminClient, json } from "../_shared/http.ts";
import { waitlist } from "../_shared/waitlist.ts";

// The caller's IP (Cloudflare's own header first: a visitor can't fake it,
// unlike the start of x-forwarded-for), scrambled with a key only the
// server has (HMAC), so the table never holds a real address: enough to
// tell one machine from another for an hour, nothing more.
async function scrambledIp(req: Request) {
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0]).trim();
  if (!ip) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  try {
    const reply = await waitlist({ admin: createAdminClient() }, await scrambledIp(req), body ?? {});
    return json(reply.body, reply.status);
  } catch (err) {
    console.error("waitlist failed", String((err as Error).message ?? err));
    return json({ ok: false, error: "server_error" }, 500);
  }
});
