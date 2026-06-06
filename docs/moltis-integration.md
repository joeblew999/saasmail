# saasmail ↔ Moltis integration

**Status:** design (no code yet) · **Branch:** `joeblew999` · **Date:** 2026-06-05

This document captures the verified architecture for bridging **saasmail** (the
unified inbox on Cloudflare Workers) with **Moltis** (a self-hosted Rust AI-agent
and multi-channel messaging gateway). It is grounded in the live Moltis API
(docs.moltis.org, verified 2026-06-05) and saasmail's current code, not on
guesses. Context: [choyiny/saasmail#111 (comment)](https://github.com/choyiny/saasmail/issues/111#issuecomment-4628633893).

## 1. Roles

|         | saasmail                                           | Moltis                                                                                                                                         |
| ------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs on | Cloudflare Workers (`saasmail.gedw99.workers.dev`) | Hetzner VM (`moltis.<domain>`)                                                                                                                 |
| Is      | the unified **inbox UI** — one timeline per person | the **multi-channel gateway** — WhatsApp / Telegram / Slack / Discord / Signal / Matrix / … (clean per-channel Rust crates), plus an LLM agent |
| Stays   | lightweight                                        | owns channel provisioning + message transport                                                                                                  |

Design intent (from the issue comment): **don't reinvent channel plumbing.**
Moltis already solves inbound+outbound for many messaging systems; saasmail
surfaces those conversations in its inbox so staff reply with full history.

> **Why not run Moltis on Workers?** Moltis is a long-running ~270K-LOC / 59-crate
> Rust server with SQLite + Docker-sandboxed tools. It is not a `workers-rs`
> binding. The "expose Moltis as a CF binding" idea floated in the issue comment
> does not hold up — Moltis runs as a server. (Also consistent with the
> no-cross-compile / use-target-VMs policy.)

## 2. Deployment — already solved

Moltis is deployed via the **`joeblew999/vm-uncloud`** repo, which has a ready
recipe:

```bash
# in vm-uncloud/
mise run up              # Hetzner box + wildcard DNS + uncloud cluster
mise run recipe moltis   # deploys ghcr.io/moltis-org/moltis:latest behind Caddy
```

The recipe (`recipes/moltis/`) publishes Moltis at `https://moltis.<domain>`
(Caddy → container port `13131`), persists `MOLTIS_TOKEN` for bootstrap auth, and
mounts the Docker socket for the agent's sandbox. First-boot setup code comes from
`uc logs moltis`. The recipe already exposes everything the bridge needs on that
host:

- `POST https://moltis.<domain>/api/webhooks/ingest/{public_id}` — inbound webhooks
- `POST https://moltis.<domain>/graphql` — GraphQL control API

## 3. Verified Moltis API surface

- **MCP — client only.** Moltis _connects out_ to MCP servers (configured in
  `moltis.toml` under `[mcp.servers.*]`, transports `stdio` / `streamable-http` /
  `sse`). It does **not** expose its own MCP server.
- **Inbound webhooks.** `POST /api/webhooks/ingest/{public_id}` where
  `public_id = wh_` + 36 hex. Auth modes include `bearer` (`Authorization`) and
  `static_header` (both fit saasmail; the HMAC modes are GitHub/Stripe/Linear/etc.
  specific). Returns `202`; a background worker creates a chat session and runs the
  bound agent.
- **GraphQL.** `POST /graphql`, `Authorization: Bearer <api_key>`. Drive the agent
  with `mutation { chat { send(message, sessionKey) { ok sessionKey } } }`.
- **No native outbound HTTP.** Moltis acts on external systems **only through
  tools** — i.e. MCP. (There is a "deliver-only" mode that forwards templated
  payloads to internal chat channels, not arbitrary HTTP.)

This last point dictates the architecture: **for Moltis to push a channel message
into saasmail, saasmail must expose an MCP tool Moltis can call.**

## 4. Bridge — two directions

### Direction A — channel → inbox (inbound)

A WhatsApp/Telegram/… message arrives at Moltis and should appear as a real
message in the saasmail inbox, threaded under that person.

```
WhatsApp ─▶ Moltis (channel crate) ─▶ [MCP tool: saasmail.ingest] ─▶ saasmail POST /api/inbound ─▶ emails row (received)
```

- Moltis has no outbound HTTP, so it reaches saasmail via an **MCP tool**.
- That tool maps to a **new `POST /api/inbound`** endpoint on saasmail — the
  keystone, and exactly what **issue #111** proposes.

### Direction B — inbox reply → channel (outbound)

Staff reply in the saasmail inbox; the reply must go back out over the originating
channel.

```
saasmail inbox reply ─▶ saasmail Worker (outbound HTTP) ─▶ Moltis /graphql chat.send  (or /api/webhooks/ingest) ─▶ channel
```

- saasmail's Worker can make outbound HTTP freely, so this direction is
  straightforward: call Moltis's GraphQL `chat.send` (or an ingest webhook) at
  `https://moltis.<domain>`, keyed by the channel/session that produced the inbound
  message.
- Requires saasmail to persist a **channel/session reference** on the inbound row
  (see §5) so a reply knows where to route.

## 5. The keystone: `POST /api/inbound` (issue #111)

Today the only ingestion path is `POST /api/send`, which is wrong for synthesized
inbound:

- `fromAddress` is gated by `assertInboxAllowed` → the message must be sent _as_
  the inbox identity (`support@ → support@`), so it looks like self-mail.
- `computeConversationId` (`worker/src/lib/conversation-id.ts`) returns `null` when
  there are fewer than 2 external participants, and excludes internal domains — a
  self-addressed row gets `conversation_id = null` and isn't grouped under the
  person.

`POST /api/inbound` instead **synthesizes a received email**, running the _same_
path as MX-delivered mail in `worker/src/email-handler.ts`:

1. Resolve/create the **person** from the real user's `from` address (not the
   inbox identity).
2. Compute externals from `[from, ...cc]` minus internal domains, then
   `computeConversationId(inbox, externals)` — identical to the MX path.
3. `db.insert(emails).values({ ... receivedAt, isRead: 0, conversationId, ... })`
   with `recipient = inbox` (canonical/lowercased), no outbound send.
4. Fire the same downstream signals the MX path does (NotificationsHub fan-out,
   person auto-create). Suppression-list updates are inbound-irrelevant.

**Request shape (proposed):**

```http
POST /api/inbound
Authorization: Bearer <saasmail-api-key>
Content-Type: application/json

{
  "from":     "user@example.com",       // the external user
  "to":       "support@yourdomain.com", // an inbox the key may write
  "subject":  "Re: my order",
  "bodyHtml": "<p>…</p>",
  "bodyText": "…",
  "cc":       [],                        // optional, multi-recipient inbound
  "source":   { "channel": "whatsapp", "sessionKey": "wa:+1555…" }  // optional, enables Direction B routing
}
```

**Open design questions (carried from issue #111, to confirm with upstream):**

1. **Auth scoping** — scope inbound-insert to a specific inbox / domain / any
   allowed inbox, same key model as `/api/send` or stricter?
2. **Attachments** — reuse `/api/send`'s multipart (`payload` + `files`)?
3. **Side effects** — fire the same notifications / person auto-create as MX mail?
   (Proposed: yes.)
4. **`from` scope** — single sender vs multi-recipient (Cc) inbound?
5. **Channel back-reference** — store `source.channel` / `source.sessionKey` (e.g.
   on the email row or a side table) so a staff reply can route back via Moltis
   (Direction B). _Not in the original issue; needed for the Moltis bridge._

## 6. Wiring (config)

**On saasmail** — a new API key scoped to the target inbox(es); used by Moltis's
MCP tool as the `Bearer` for `/api/inbound`. Stored in Moltis's config/secret store.

**On Moltis** (`moltis.toml`) — register the saasmail MCP server (assumes an
saasmail-side MCP route is built; see §7):

```toml
[mcp.servers.saasmail]
transport = "streamable-http"
url       = "https://saasmail.gedw99.workers.dev/mcp"
headers   = { Authorization = "Bearer ${SAASMAIL_API_KEY}" }
```

**On saasmail Worker** (Direction B) — a Moltis API key + base URL as secrets
(`MOLTIS_BASE_URL=https://moltis.<domain>`, `MOLTIS_API_KEY`), used to call
`chat.send`. Managed via the fork's fnox → mise → wrangler secret flow.

## 7. Build order

1. **`POST /api/inbound`** on the `joeblew999` branch (ideally upstreamed as the
   issue #111 PR). Unblocks everything. _(keystone)_
2. **saasmail MCP route** (`/mcp`, streamable-http) exposing at minimum an
   `ingest` tool → `/api/inbound`, plus `send` / `templates` as useful agent tools.
   This is what makes Direction A work, since Moltis only calls out via MCP.
3. **Direction B outbound** — saasmail reply hook → Moltis `chat.send`, keyed by
   the stored channel/session reference.
4. **Config + secrets glue** (§6) and an end-to-end smoke test (WhatsApp in →
   inbox → reply → WhatsApp out).

## 8. Status snapshot (2026-06-05)

- saasmail `joeblew999`: rebased onto upstream **v0.6.0**, builds clean
  (`tsc` + `vite build`). Overlay intact. Not yet pushed to origin.
- Moltis deploy: **ready** via `vm-uncloud` `recipes/moltis`.
- Bridge: **unbuilt**. `/api/inbound` (issue #111) is the first task.
