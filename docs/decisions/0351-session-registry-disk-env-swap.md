# ADR-0351 — Session-registry disk-adapter env-var swap

Status: Accepted
Date: 2026-05-27

## Context

ADR-0347 shipped `getGlobalSessionResourceRegistry()` — a process-level
singleton that lazy-mints an in-memory `SessionResourceRegistry`. ADR-0348
shipped `createDiskSessionResourceRegistry(cfg)` — a jsonl-backed sibling
adapter behind the same port. The two adapters were correct but disjoint:
nothing in the codebase chose between them, so the disk adapter was
unreachable from production.

## Decision

At the first `getGlobalSessionResourceRegistry()` call, consume the shared
`runtimeConfig()` snapshot containing
`QUANTA_SESSION_REGISTRY_DISK_DIR`. If set (non-empty), mint
`createDiskSessionResourceRegistry({ storageDir })`. Otherwise legacy
in-memory. NO-THROW: a malformed env var (path that disk-adapter cannot
mkdir-under) falls back to in-memory silently rather than abort process
startup.

Env-var contract:

| Env value | Backend |
|---|---|
| unset | in-memory (legacy) |
| empty string `""` | in-memory (treated as absent) |
| valid dir path | disk-backed (jsonl) |
| invalid path (mkdir fails) | in-memory (NO-THROW fallback) |

The snapshot is captured inside the singleton mint, so runtime mutation after
the first call is ignored (per the lazy-init contract). Tests use
`resetGlobalSessionResourceRegistry()` to re-trigger snapshot construction.

## Non-goals

- **Settings.json route.** Some quanta features accept either env var or
  settings.json toggle; this one is env-only because the singleton lives
  process-wide and reading settings.json would require an async I/O at
  module-import time. A future ADR can route settings → env via the
  composition root.
- **Per-session backend choice.** All sessions in one process share the
  same backend. Mixed in-memory + disk in one process is out of scope
  (the registry is a singleton).
- **Runtime backend swap.** Tests can `resetGlobalSessionResourceRegistry()`
  to swap; production does not.
- **SQLite backend selection.** ADR-0354 ships a sqlite sibling; routing
  env→sqlite is a follow-up ADR layered on this one.

## Wiring

Composition roots (apps/agent/assemble.ts, ADR-0334+0347) call
`getGlobalSessionResourceRegistry()` already — no further change.
Operators opt into disk-backed by setting the env var BEFORE launching
quanta.

Example:

```sh
export QUANTA_SESSION_REGISTRY_DISK_DIR="$HOME/.quanta/sessions"
quanta
```

## Tests

`tests/unit/session-registry-env-swap-hellgate.test.ts` — 6 cases / 10
expects: unset / empty-string / valid-dir / read-once / reset-re-reads /
hosed-env NO-THROW.

`bun test tests/unit/session-registry-env-swap-hellgate.test.ts` ⇒ 6/0 fail.

## Consequences

- **Operators can opt-in to durable sessions** with one env var; no code
  change at the call sites.
- **Backward compatible.** Existing deployments without the env var see
  byte-identical behaviour.
- **Fail-soft.** A mistyped path does not break the process — the
  registry silently uses in-memory. Operators detect via
  ADR-0352 metrics (registry-misses spike when persistence was expected).

## References

- ADR-0345 — in-memory registry foundation
- ADR-0347 — global singleton wire
- ADR-0348 — disk-persistent jsonl adapter
- ADR-0352 — observability metrics (detects fallback)
- ADR-0354 — sqlite backend (sibling adapter, separate env knob in a future ADR)
