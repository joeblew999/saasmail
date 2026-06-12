import { Hono } from "hono";
import { createEmailSender } from "../lib/email-sender";

/**
 * Inbound webhook for Rauthy's transactional email.
 *
 * Rauthy (the OIDC IdP, run UNMODIFIED) sends mail over SMTP. The vm-uncloud
 * `rauthy` recipe runs a tiny `smtp2http` "bridge" alongside it that forwards
 * each outbound message to THIS endpoint as `application/x-www-form-urlencoded`;
 * we send it via the existing Cloudflare Email sender. So Rauthy needs zero
 * changes, and the CF-send code lives here where email-sending belongs.
 *
 *   Rauthy ──SMTP──► bridge (smtp2http) ──POST──► /api/rauthy-inbound ──► CF Email
 *
 * Auth: smtp2http can't add request headers, so the recipe's
 * `RAUTHY_EMAIL_WEBHOOK` carries a shared secret as `?key=…`, checked here
 * against `RAUTHY_WEBHOOK_SECRET`. This path is on the unauthenticated-path
 * allowlist in index.ts (the bridge has no session), so this guard IS the auth.
 *
 * Form fields are verified against alash3al/smtp2http's actual output.
 */
export const rauthyInboundRouter = new Hono<{
  Bindings: Env & { RAUTHY_WEBHOOK_SECRET?: string };
}>();

rauthyInboundRouter.post("/", async (c) => {
  const secret = c.env.RAUTHY_WEBHOOK_SECRET;
  if (!secret || c.req.query("key") !== secret) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const form = await c.req.parseBody();
  const field = (k: string): string =>
    typeof form[k] === "string" ? (form[k] as string) : "";

  const from = field("addresses[from]");
  const to = field("addresses[to]");
  const subject = field("subject");
  const text = field("body[text]");
  const html = field("body[html]") || textToHtml(text);

  if (!from || !to) {
    return c.json({ error: "missing from/to" }, 400);
  }

  const sender = createEmailSender(c.env);
  const result = await sender.send({ from, to, subject, html, text });
  return c.json({ ok: true, id: result.id });
});

/** Rauthy can send plaintext-only mail; wrap it so CF Email always has HTML. */
function textToHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${esc}</pre>`;
}
