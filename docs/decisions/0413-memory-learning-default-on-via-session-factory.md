# ADR-0413 — Memory learning DEFAULT-ON via session factory

**Status:** Accepted (2026-05-28)
**Slice:** new `src/runner/assemble/memory-factory.ts` (`buildMemoryForSession`) + barrel export (`src/runner/assemble/index.ts`) + `buildStore` delegation (`src/apps/cli/internal.ts`) + auto-trigger wire (`src/memory/auto-trigger/wire.ts`) + unified-agent composition (`src/apps/agent/index.ts`) + hellgate (`tests/unit/memory-factory-hellgate.test.ts`).
**Default-ON (env-disablable, zero disk side effects):** Memory learning is ON by default backed by a VOLATILE `InMemoryStore`. `QUANTA_MEMORY ∈ {off,0,false,no}` OR `override.storeDisabled:true` restores byte-identical legacy no-memory behavior. On-disk persistence (`SqliteStore`) stays an EXPLICIT opt-in via `QUANTA_MEMORY=sqlite`.

## Context

Memory learning (long-term store + recall + consolidation + cross-session auto-trigger) was default-OFF, resolved independently at three call sites:

- `buildStore()` in `src/apps/cli/internal.ts` — `QUANTA_MEMORY` unset ⇒ `undefined` store.
- the recall gate in `src/agent/loop.ts` — `if (!config.store) return undefined`.
- the auto-trigger wire in `src/memory/auto-trigger/wire.ts` — `QUANTA_MEMORY_AUTO !== "on"` ⇒ `null`.

A fresh install therefore got NO cross-session knowledge accumulation until the operator set three separate env knobs — defeating the SOTA goal of memory-by-default (matching Codex/Claude). The three sites could also drift (one ON, two OFF) with no single source of truth.

## Decision

Introduce one canonical factory `buildMemoryForSession(env, override?)` in the surface-agnostic `runner/assemble` layer that resolves all three slots (`store` / `config` / `autoTrigger`) with **default-ON** semantics. The CLI, the unified-agent root, and the auto-trigger wire all consult this single factory. The factory is PURE w.r.t. its `env` argument (no `process.env` read — the surface owns the read), keeping the `runner → apps` slice direction intact.

### Default-ON safety — volatile store, opt-in persistence

The default-ON `kind` is the **volatile `InMemoryStore`**, never the on-disk `SqliteStore`. A fresh run with no env knob (or a bare truthy `QUANTA_MEMORY=1`) learns in-process only and writes NOTHING to disk — so turning the feature on by default introduces zero filesystem side effects. Persistent cross-process memory is an explicit opt-in: the operator sets `QUANTA_MEMORY=sqlite` (with optional `QUANTA_MEMORY_PATH`). This keeps the default safe while still giving the model in-session recall + consolidation.

### Single-knob escape hatch (byte-identical)

Two equivalent ways to restore the legacy default-OFF behavior:

- `override.storeDisabled === true` — env fully ignored, no allocation. Used by bench/replay for determinism.
- `env.QUANTA_MEMORY ∈ {0,false,off,no}` — single operator knob. Cascades to ALL slots OFF (a surviving auto-trigger with no store to write would be a no-op anyway).

Either path collapses the factory output to `{}`, equivalent to the prior `buildStore()===undefined` + `buildMemoryConfig(undefined)===undefined` + `assembleMemoryAuto()===null`.

### Configurable knobs

| Knob | Default | Effect |
|---|---|---|
| `QUANTA_MEMORY` | on (volatile) | `off/0/false/no`→OFF · `memory`→volatile · `sqlite`→on-disk |
| `QUANTA_MEMORY_PATH` | `.quanta/memory.sqlite` | sqlite path (sqlite kind only) |
| `QUANTA_MEMORY_AUTO` | on | cross-session auto-trigger off-switch |
| `QUANTA_MEMORY_RECALL_LIMIT` | adapter default | recall window size |
| `QUANTA_MEMORY_RECALL_TIERS` | all | comma list (episodic,semantic) |
| `QUANTA_MEMORY_DISTILL` | on | `off`→no LLM distill |
| `QUANTA_MEMORY_CONSOLIDATE` | on | `off`→no consolidate |
| `QUANTA_MEMORY_SELF_EDIT` | on | `off`→no `memory_*` self-edit tools |
| `QUANTA_MEMORY_THRESHOLD` | 0.7 | auto-trigger promote threshold |
| `QUANTA_MEMORY_MIN_USAGE` | 1 | auto-trigger min usage gate |

Plus `override.{storeDisabled,recallLimit,autoTrigger,storePath}` for programmatic callers (e.g. tests that don't mutate `process.env`). `override.autoTrigger: null` forces auto-trigger OFF even when env enables it.

## Consequences

- **Fresh install** gets in-session memory learning + recall by default; persistent cross-process memory is one knob (`QUANTA_MEMORY=sqlite`) away.
- **No disk surprise**: the default is volatile, so CI / ephemeral runs leave no `.quanta/memory.sqlite` behind.
- **Bench/replay determinism**: the `storeDisabled` override (or `QUANTA_MEMORY=off`) keeps the byte-identical no-memory path. The bench driver's `capabilityManifest.memory=false` stays as a belt-and-suspenders second guard.
- **Single source of truth**: the three former call sites now delegate to the factory, eliminating ON/OFF drift.
- **Supersedes**: none. Extends the wiring of ADR-0078 (redaction) / ADR-0082 (citation) / ADR-0164 (secret detection) / ADR-0281–0282 (auto-trigger) without changing their contracts.
