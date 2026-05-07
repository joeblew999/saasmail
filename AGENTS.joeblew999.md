# AGENTS.joeblew999.md — branch-local agent guide

Operational brief for any AI agent working on the `joeblew999` branch of `saasmail`.

**Three guides apply, in this order:**
1. **[org-wide rules](https://github.com/joeblew999/.github/blob/main/AGENTS.md)** — joeblew999/.github/AGENTS.md. Mise + nu + TOML-task authoring conventions, shared lib usage. The SSOT for everything that is not specific to one repo.
2. **upstream CLAUDE.md / AGENTS.md** (if any) — project-level rules from the upstream maintainer.
3. **This file** — branch-local quirks specific to the joeblew999 fork.

## What this repo is

Email-routing SaaS fork. cf:provision-queues for the EMAIL_QUEUE; deploy via 10-deploy.

## Branch-local quirks

yarn-based husky pre-commit upstream — bypassed via --no-verify when committing mise.toml-only changes.

## Mise wiring

See [mise.toml](mise.toml) for the active includes (v0.18.0+ TOML-task pattern with extends). Local pre-push lint:

```
mise run check
```

This is a thin wrapper that calls `ci:parse-check`, `ci:check-toml-tasks`, and `ci:check-workflow-nu` from the shared lib. All three are no-ops in repos lacking their target dirs. Use it before every push.
