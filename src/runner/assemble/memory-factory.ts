/**
 * ADR-0414 — Memory learning DEFAULT-ON via session factory.
 *
 * (Renumbered from 0413 → 0414 under the user-deference ADR-collision policy:
 *  the user's in-flight `0413-file-mention-kind-sync-additive.md` keeps 0413;
 *  this memory slice + its sibling AgentConfig-slot Part 1 take the next free
 *  number 0414.)
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
import { parseEnvFlag } from "./env-flag"
import { buildMemoryConfigCore, type MemoryConfigAssembleInput, parseRecallTiers } from "./memory"
import { buildStoreCore } from "./store"

/* ------------------------------------------------------------------ */
/* public types                                                        */
/* ------------------------------------------------------------------ */

/** Trigger policy mirror of `@/memory/auto-trigger`'s `TriggerPolicy`.
 *  Re-declared inline so the factory has zero compile-time dependency on
 *  the auto-trigger slice — surfaces wire the concrete trigger at the
 *  plug site, and the factory only carries the resolved knobs. */
export interface MemoryAutoTriggerPolicy {
  /** Phase-2 promote threshold (default 0.7). */
  readonly promoteThreshold: number
  /** Minimum usageCount gate (default 1). */
  readonly minUsageCount: number
}

/** The resolved memory slots for one session. Every field is optional —
 *  absent ⇒ that slot is omitted at the host plug site (legacy
 *  byte-identical when the whole shape is `{}`). */
export interface MemorySessionSlot {
  readonly store?: PersistentStorePort
  readonly config?: AgentConfig["memory"]
  readonly autoTrigger?: MemoryAutoTriggerPolicy
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
/* defaults                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_AUTO_TRIGGER_POLICY: MemoryAutoTriggerPolicy = {
  promoteThreshold: 0.7,
  minUsageCount: 1,
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/** Resolve the `kind` argument to `buildStoreCore` from the env value
 *  and the default-ON contract. Accepts the legacy literal kinds
 *  ("sqlite" / "memory") AND the new truthy/falsey set.
 *
 *  SAFETY (TKT-003 req #4): the default-ON kind is the VOLATILE
 *  `InMemoryStore`, never the on-disk `SqliteStore`. A fresh run with no
 *  env knob (or a bare truthy `QUANTA_MEMORY=1`) learns in-process only and
 *  writes NOTHING to disk — so turning the feature on by default introduces
 *  zero filesystem side effects. Persistent cross-process memory is an
 *  EXPLICIT opt-in: the operator must set `QUANTA_MEMORY=sqlite` (with an
 *  optional `QUANTA_MEMORY_PATH`). This keeps the default safe while still
 *  giving the model in-session recall + consolidation. */
const resolveStoreKind = (raw: string | undefined): string | undefined => {
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
 *  operator explicitly opts out. Mirrors the env truth-table of
 *  `parseEnvFlag` — invalid value ⇒ default = ON. */
const resolveAutoTrigger = (env: NodeJS.ProcessEnv): MemoryAutoTriggerPolicy | undefined => {
  const enabled = parseEnvFlag(env.QUANTA_MEMORY_AUTO, /* defaultOn */ true)
  if (!enabled) return undefined
  const rawT = env.QUANTA_MEMORY_THRESHOLD
  const rawU = env.QUANTA_MEMORY_MIN_USAGE
  const parsedT = rawT === undefined ? DEFAULT_AUTO_TRIGGER_POLICY.promoteThreshold : Number(rawT)
  const parsedU = rawU === undefined ? DEFAULT_AUTO_TRIGGER_POLICY.minUsageCount : Number(rawU)
  const promoteThreshold = Number.isFinite(parsedT)
    ? parsedT
    : DEFAULT_AUTO_TRIGGER_POLICY.promoteThreshold
  const minUsageCount =
    Number.isFinite(parsedU) && parsedU >= 0
      ? Math.floor(parsedU)
      : DEFAULT_AUTO_TRIGGER_POLICY.minUsageCount
  return { promoteThreshold, minUsageCount }
}

/** Resolve the memory tuning config from env + store. Mirrors the legacy
 *  `buildMemoryConfig` exactly so the `MemoryConfigAssembleInput` shape
 *  feeding `buildMemoryConfigCore` is verbatim of what cli/internal.ts
 *  produced before — i.e. byte-identical config bytes when env matches. */
const resolveMemoryConfig = (
  env: NodeJS.ProcessEnv,
  store: PersistentStorePort | undefined,
  override: MemorySessionOverride | undefined,
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
  const distillOff = env.QUANTA_MEMORY_DISTILL === "off"
  const consolidateOff = env.QUANTA_MEMORY_CONSOLIDATE === "off"
  const selfEditOff = env.QUANTA_MEMORY_SELF_EDIT === "off"
  const input: MemoryConfigAssembleInput = {
    store,
    ...(resolvedLimit !== undefined ? { recallLimit: resolvedLimit } : {}),
    ...(distillOff ? { distill: false } : {}),
    ...(consolidateOff ? { consolidate: false } : {}),
    ...(selfEditOff ? { selfEditTools: false } : {}),
    ...(recallTiers ? { recallTiers } : {}),
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
  const store = buildStoreCore({
    kind,
    ...(override?.storePath !== undefined
      ? { path: override.storePath }
      : env.QUANTA_MEMORY_PATH !== undefined
        ? { path: env.QUANTA_MEMORY_PATH }
        : {}),
  })
  const config = resolveMemoryConfig(env, store, override)
  // Auto-trigger: override wins; null forces off, undefined falls through
  // to env. The env path is default-ON.
  const autoTrigger =
    override?.autoTrigger === null ? undefined : (override?.autoTrigger ?? resolveAutoTrigger(env))
  return {
    ...(store !== undefined ? { store } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(autoTrigger !== undefined ? { autoTrigger } : {}),
  }
}
