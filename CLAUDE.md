# saasmail

Self-hosted email server on Cloudflare Workers. See README.md for full documentation.

## Development

- Use `yarn` for all dependency commands (not npm)
- Backend: Hono + Zod OpenAPI routes in `worker/src/routers/`
- Frontend: React + Tailwind in `src/`
- Database: Drizzle ORM with D1 in `worker/src/db/`
- Run `yarn tsc --noEmit` to type-check before committing
- Run `yarn test` for tests

## Skills

- `/saasmail-onboarding` — Interactive setup wizard for deploying a new saasmail instance
- `/use-saasmail` — How to call a deployed saasmail instance's HTTP API to send emails (raw or via templates) and enroll recipients in sequences

## Fork model — merge upstream IN, don't rebase

This is a fork. **`main` = OUR saasmail** (upstream + our overlay: mise/fnox/CI
tooling, the Moltis bridge, the Rauthy inbound handler). It is the default
branch and where you work.

To pull upstream changes: `git fetch upstream && git merge upstream/main` into
`main` — a **merge** (merge commit), never a rebase. Rebasing replayed our
growing overlay on every sync and kept biting (see the old
`backup/joeblew999-pre-rebase`); merging stops that. Upstreamable fixes still go
out as clean PRs from short branches off `upstream/main`.

(The old `joeblew999` overlay branch was consolidated INTO `main` 2026-06-12.)
