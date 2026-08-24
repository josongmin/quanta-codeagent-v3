/**
 * ADR-0413 — Memory learning DEFAULT-ON via session factory.
 *
 * (The canonical decision record is
 *  `docs/decisions/0413-memory-learning-default-on-via-session-factory.md`,
 *  which coexists at number 0413 alongside the user's
 *  `0413-file-mention-kind-sync-additive.md`. An earlier draft planned a
 *  0413 → 0414 renumber, but no 0414 record was ever cut, so this slice's
 *  canonical number is 0413 — matched by the feature catalog `adrs: [413]`.)
 *
 * Single canonical entry point that projects an env view + per-session
 * override into the three memory slots a surface needs to wire:
 *
 *   1. `store`         — `PersistentStorePort` (Sqlite | InMemory | undefined)
 *   2. `config`        — `AgentConfig["memory"]` tuning block
 *   3. `autoTrigger`   — `TriggerPolicy` for the auto-trigger / cross-session-
 *                        inject slice (ADR-0281 / ADR-0282)
 *
 * Before this ADR, each of those three slots was env-default-OFF, resolved
 * in three different call sites (cli internal, agent index, retrieval gate).
 * The result was that an operator who installed the agent fresh got "no
 * memory learning" until they set three env knobs — defeating the SOTA goal
 * of cross-session knowledge accumulation.
 *
 * After this ADR: a single `buildMemoryForSession(env, override?)` resolves
 * all three slots with `default = ON`. Bench / replay paths flip a single
 * `override.storeDisabled: true` (or `QUANTA_MEMORY=off`) to get the prior
 * byte-identical no-memory behavior — escape hatch is one boolean.
 *
 * SLICE FENCE: this file lives in `src/runner/assemble/` so the CLI app
 * surface (`src/apps/cli/internal.ts`) and the unified-agent composition
 * root (`src/apps/agent/index.ts`) both depend on it without violating
 * the `runner → apps` direction. The factory is PURE w.r.t. its `env`
 * input (no `process.env` reads); the surface owns the env read.
 *
 * BYTE-IDENTICAL ESCAPE HATCH (sealed by hellgate):
 *   - `override.storeDisabled === true` ⇒ `{}` (all slots omitted)
 *   - `env.QUANTA_MEMORY` ∈ {0, false, off, no} ⇒ same `{}`
 *   - either path is equivalent to the legacy default-OFF behavior of
 *     `buildStore() === undefined` + `buildMemoryConfig(undefined) ===
 *     undefined` + `assembleMemoryAuto() === null` (collapsed at the
 *     factory boundary so callers only need one knob).
 */

import type { AgentConfig } from "@/agent"
import type { PersistentStorePort } from "@/memory"
import { assembleMemoryAuto } from "@/memory/auto-trigger"
import {
  parseMemoryLineCitations,
  parseMemoryThreadMode,
  parseMemoryWriteGuardPct,
} from "@/runner/knobs/memory-mode-parse"
import { gateDisabled, gateOn } from "@/shared"
import { parseEnvFlag } from "./env-flag"
import { buildMemoryConfigCore, type MemoryConfigAssembleInput, parseRecallTiers } from "./memory"
import { buildStoreCore } from "./store"

/* ------------------------------------------------------------------ */
/* public types                                                        */
/* ------------------------------------------------------------------ */

/** Trigger policy mirror of `@/memory/auto-trigger`'s `TriggerPolicy`. The
 *  SHAPE is re-declared so callers of this factory never import the trigger
 *  slice for a type; the VALUES are resolved by delegating to that slice's
 *  `assembleMemoryAuto` (ADR-0555 — one env→policy projection, not two copies
 *  that can drift). */
export interface MemoryAutoTriggerPolicy {
  /** Phase-2 promote threshold (default 0.7). */
  readonly promoteThreshold: number
  /** Minimum usageCount gate (default 1). */
  readonly minUsageCount: number
}

/** The two store kinds the factory can resolve. `"memory"` is the VOLATILE
 *  `InMemoryStore` (default-ON, gone at process exit); `"sqlite"` is the
 *  on-disk `SqliteStore` (explicit `QUANTA_MEMORY=sqlite` opt-in). */
export type MemoryStoreKind = "memory" | "sqlite"

/** The resolved memory slots for one session. Every field is optional —
 *  absent ⇒ that slot is omitted at the host plug site (legacy
 *  byte-identical when the whole shape is `{}`). */
export interface MemorySessionSlot {
  readonly store?: PersistentStorePort
  readonly config?: AgentConfig["memory"]
  readonly autoTrigger?: MemoryAutoTriggerPolicy
  /** ADR-0555 — the RESOLVED kind of `store` (never the raw env token, which
   *  the CLI seeds as `"1"`). Present iff `store` is present, so a surface can
   *  tell the operator the truth (`kind=memory (volatile)`) instead of echoing
   *  the env value. */
  readonly kind?: MemoryStoreKind
  /** ADR-0555 — the resolved on-disk path; present iff `kind === "sqlite"`. */
  readonly storePath?: string
}

/** Per-session override surface. Bench / replay sets `storeDisabled:true`
 *  for byte-identical determinism. Callers can also force a specific
 *  recall-limit or auto-trigger policy independent of env (used by tests
 *  that don't want to mutate `process.env`). */
export interface MemorySessionOverride {
  /** Hard OFF — env is fully ignored. The escape hatch for bench/replay. */
  readonly storeDisabled?: boolean
  /** Recall-limit override (wins over `QUANTA_MEMORY_RECALL_LIMIT`). */
  readonly recallLimit?: number
  /** Auto-trigger policy override (wins over env-derived policy). Pass
   *  `null` to FORCE auto-trigger OFF even when env enables it. */
  readonly autoTrigger?: MemoryAutoTriggerPolicy | null
  /** Override the sqlite path. Wins over `QUANTA_MEMORY_PATH`. */
  readonly storePath?: string
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/** Default sqlite path when `QUANTA_MEMORY_PATH` / `override.storePath` are
 *  both absent — mirrors `buildStoreCore`'s own fallback so the `storePath`
 *  the slot REPORTS is the path the store actually opened. */
const DEFAULT_SQLITE_PATH = ".quanta/memory.sqlite"

/** Resolve the `kind` argument to `buildStoreCore` from the env value
 *  and the default-ON contract. Accepts the legacy literal kinds
 *  ("sqlite" / "memory") AND the new truthy/falsey set.
 *
 *  SAFETY (TKT-003 req #4): the default-ON kind is the VOLATILE
 *  `InMemoryStore`, never the on-disk `SqliteStore`. A fresh run with no
 *  env knob (or a bare truthy `QUANTA_MEMORY=1`) learns in-process only:
 *  THIS store writes nothing to disk and is gone at process exit (its
 *  contents are NOT kept across restarts — ADR-0555 makes the surfaces say
 *  so). Note this is a property of the STORE, not of the launch: the
 *  session-memory (B) and consolidator (C) systems still write under
 *  `~/.quanta/memory/` by default regardless of this kind. Persistent
 *  cross-process memory for THIS store is an EXPLICIT opt-in: the operator
 *  must set `QUANTA_MEMORY=sqlite` (with an optional `QUANTA_MEMORY_PATH`).
 *  This keeps the default safe while still giving the model in-session
 *  recall + consolidation. */
const resolveStoreKind = (raw: string | undefined): MemoryStoreKind | undefined => {
  if (raw === undefined) return "memory"
  const v = raw.trim().toLowerCase()
  // Explicit kinds — pass through verbatim. `sqlite` is the ONLY way to opt
  // into the on-disk store (persistent memory is opt-in, never default).
  if (v === "sqlite" || v === "memory") return v
  // Falsey set — disable store entirely (legacy default-OFF escape hatch).
  if (v === "0" || v === "false" || v === "off" || v === "no") return undefined
  // Truthy set (incl. empty string) — default to the VOLATILE kind so an
  // operator who sets a bare `QUANTA_MEMORY=1` still gets no-disk memory.
  if (parseEnvFlag(raw, /* defaultOn */ true)) return "memory"
  return undefined
}

/** Resolve the auto-trigger policy from env. Default-ON unless the
 *  operator explicitly opts out. ADR-0555: this DELEGATES to the trigger
 *  slice's own `assembleMemoryAuto` (the env truth-table lives there once —
 *  `QUANTA_MEMORY_AUTO` / `_THRESHOLD` / `_MIN_USAGE`, invalid ⇒ default);
 *  this file used to carry a verbatim copy that could drift. `null` from the
 *  slice ⇒ `undefined` here (slot omitted). */
const resolveAutoTrigger = (env: NodeJS.ProcessEnv): MemoryAutoTriggerPolicy | undefined => {
  const auto = assembleMemoryAuto(env)
  if (auto === null) return undefined
  const { promoteThreshold, minUsageCount } = auto.policy
  return { promoteThreshold, minUsageCount }
}

/**
 * Resolve the memory tuning config from env + store. This is the SINGLE
 * source of truth for the env → `MemoryConfigAssembleInput` projection
 * (recallLimit / distill / consolidate / selfEditTools / recallTiers).
 *
 * ADR-0414 centralization: the CLI surface (`src/apps/cli/internal.ts`
 * `buildMemoryConfig`) USED to re-read the same `QUANTA_MEMORY_*` knobs into
 * an identical `buildMemoryConfigCore` call — a verbatim copy-paste of this
 * function. That copy is gone: `buildMemoryConfig` now delegates here so the
 * env-read truth lives in exactly one place. `buildMemoryForSession` also
 * routes through this helper, so every surface produces byte-identical config
 * bytes for the same env.
 *
 * Pure w.r.t `process.env` (the caller passes the env view). The `store`
 * argument only affects whether an EMPTY block is still returned (a present
 * store forces a truthy block so the loop wires it; absent store + no knobs
 * collapses to `undefined`) — it never changes the knob values.
 */
export const resolveMemoryConfigFromEnv = (
  env: NodeJS.ProcessEnv,
  store: PersistentStorePort | undefined,
  override?: MemorySessionOverride,
): AgentConfig["memory"] | undefined => {
  const rawLimit = env.QUANTA_MEMORY_RECALL_LIMIT
  const envLimit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : Number.NaN
  // Override wins over env. Strict finite-number gate either way.
  const resolvedLimit =
    override?.recallLimit !== undefined && Number.isFinite(override.recallLimit)
      ? override.recallLimit
      : Number.isFinite(envLimit)
        ? envLimit
        : undefined
  const recallTiers = parseRecallTiers(env.QUANTA_MEMORY_RECALL_TIERS)
  const distillOff = gateDisabled(env, "QUANTA_MEMORY_DISTILL")
  const consolidateOff = gateDisabled(env, "QUANTA_MEMORY_CONSOLIDATE")
  const selfEditOff = gateDisabled(env, "QUANTA_MEMORY_SELF_EDIT")
  // ADR-0432 default-OFF extras. Reuse the knob's pure parse helpers so the
  // env→config projection is identical between the CLI env-read path and the
  // knob framework surface (single source of truth). Any unresolved axis is
  // omitted ⇒ that field stays absent ⇒ byte-identical legacy behaviour.
  const threadMode = parseMemoryThreadMode(env.QUANTA_MEMORY_MODE)
  const lineCitations = parseMemoryLineCitations(env.QUANTA_MEMORY_LINE_CITATIONS)
  const writeGuardPct = parseMemoryWriteGuardPct(env.QUANTA_MEMORY_WRITE_GUARD_PCT)
  // §10.6 routing weighting — default-OFF opt-in. Read via the canonical
  // gateOn vocab so `QUANTA_MEMORY_ROUTING` in {1,on,true,yes} all enable it.
  const routingEnabled = gateOn(env, "QUANTA_MEMORY_ROUTING")
  const input: MemoryConfigAssembleInput = {
    store,
    ...(resolvedLimit !== undefined ? { recallLimit: resolvedLimit } : {}),
    ...(distillOff ? { distill: false } : {}),
    ...(consolidateOff ? { consolidate: false } : {}),
    ...(selfEditOff ? { selfEditTools: false } : {}),
    ...(recallTiers ? { recallTiers } : {}),
    ...(threadMode !== undefined ? { threadMode } : {}),
    ...(lineCitations !== undefined ? { lineCitations } : {}),
    ...(writeGuardPct !== undefined ? { writeGuardMinRemainingPercent: writeGuardPct } : {}),
    ...(routingEnabled ? { routingEnabled: true } : {}),
  }
  return buildMemoryConfigCore(input)
}

/* ------------------------------------------------------------------ */
/* public                                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve the three memory slots for one session.
 *
 * - `override.storeDisabled === true` ⇒ `{}` (bench/replay byte-identical).
 * - Otherwise: env is consulted with default-ON semantics. The legacy
 *   `QUANTA_MEMORY=off` (or any falsey value) still flips the whole
 *   bundle to `{}` — single knob escape hatch.
 *
 * Pure: never reads `process.env`. The surface owns the env read.
 * Deterministic: same input ⇒ same shape (store identity is freshly
 * allocated each call — surfaces share a single call per session).
 */
export const buildMemoryForSession = (
  env: NodeJS.ProcessEnv,
  override?: MemorySessionOverride,
): MemorySessionSlot => {
  // Hard escape hatch — bench/replay. No env read, no allocation.
  if (override?.storeDisabled === true) return {}
  const kind = resolveStoreKind(env.QUANTA_MEMORY)
  // Single-knob escape hatch: `QUANTA_MEMORY=off` (kind===undefined) cascades
  // to ALL slots OFF. The auto-trigger has no store to write to, so a
  // surviving auto-trigger would be a no-op anyway; the cascade keeps the
  // "one knob = legacy off" contract intact (mirrors the storeDisabled
  // hard path above).
  if (kind === undefined) return {}
  // Resolved path (override > env > default) — reported on the slot for the
  // sqlite kind so surfaces name the file the store actually opened.
  const storePath = override?.storePath ?? env.QUANTA_MEMORY_PATH ?? DEFAULT_SQLITE_PATH
  const store = buildStoreCore({ kind, path: storePath })
  const config = resolveMemoryConfigFromEnv(env, store, override)
  // Auto-trigger: override wins; null forces off (ADR-0413 veto arm), undefined
  // falls through to env. The env path is default-ON.
  const autoTrigger =
    override?.autoTrigger === null ? undefined : (override?.autoTrigger ?? resolveAutoTrigger(env))
  return {
    ...(store !== undefined ? { store, kind } : {}),
    ...(store !== undefined && kind === "sqlite" ? { storePath } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(autoTrigger !== undefined ? { autoTrigger } : {}),
  }
}
