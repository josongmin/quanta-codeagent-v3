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
 * override into the memory slots a surface needs to wire:
 *
 *   1. `store`         — `PersistentStorePort` (Sqlite | InMemory | undefined)
 *   2. `config`        — `AgentConfig["memory"]` tuning block
 *
 * (A third slot, `autoTrigger`, mirrored the `QUANTA_MEMORY_AUTO` gate and the
 * cross-session-inject promotion policy; no host consumed it and it went with
 * ADR-0556. The gate is read at `@/memory/auto-trigger` by the session wire.)
 *
 * Before this ADR, each of those slots was env-default-OFF, resolved
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
 *     undefined` (collapsed at the factory boundary so callers only need
 *     one knob). The session-end auto-trigger gate (`QUANTA_MEMORY_AUTO`)
 *     is read by `@/memory/auto-trigger` at its own wire site; this factory
 *     used to mirror it into an `autoTrigger` slot nobody consumed
 *     (removed with ADR-0556).
 */

import type { AgentConfig } from "@/agent"
import { InMemoryStore, type PersistentStorePort } from "@/memory"
import { resolveStorePath, type StorePathResolution } from "@/memory/store-path"
import {
  parseMemoryLineCitations,
  parseMemoryThreadMode,
  parseMemoryWriteGuardPct,
} from "@/runner/knobs/memory-mode-parse"
import { errMessage, gateDisabled, gateOn, logger, quantaHomeDirFrom } from "@/shared"
import { parseEnvFlag } from "./env-flag"
import { buildMemoryConfigCore, type MemoryConfigAssembleInput, parseRecallTiers } from "./memory"
import { buildStoreCore } from "./store"

/* ------------------------------------------------------------------ */
/* public types                                                        */
/* ------------------------------------------------------------------ */

/** The two store kinds the factory can resolve. `"sqlite"` is the on-disk
 *  `SqliteStore` (ADR-0557: the DEFAULT, home-scoped); `"memory"` is the
 *  VOLATILE `InMemoryStore` (explicit `QUANTA_MEMORY=memory`, or the attributed
 *  fallback when the sqlite file cannot be opened). */
export type MemoryStoreKind = "memory" | "sqlite"

/** The resolved memory slots for one session. Every field is optional —
 *  absent ⇒ that slot is omitted at the host plug site (legacy
 *  byte-identical when the whole shape is `{}`). */
export interface MemorySessionSlot {
  readonly store?: PersistentStorePort
  readonly config?: AgentConfig["memory"]
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
 *  recall-limit independent of env (used by tests that don't want to
 *  mutate `process.env`). */
export interface MemorySessionOverride {
  /** Hard OFF — env is fully ignored. The escape hatch for bench/replay. */
  readonly storeDisabled?: boolean
  /** Recall-limit override (wins over `QUANTA_MEMORY_RECALL_LIMIT`). */
  readonly recallLimit?: number
  /** Override the sqlite path. Wins over `QUANTA_MEMORY_PATH`. */
  readonly storePath?: string
  /** ADR-0557 — the QUANTA HOME the default `<quanta-home>/memory/memory.sqlite`
   *  is resolved under. Defaults to `quantaHomeDirFrom(env)`
   *  (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`); tests inject a temp dir so
   *  the real home is never touched. It used to default to `env.HOME` then
   *  `os.homedir()`, which is why a relocated `QUANTA_HOME` moved sessions and knobs
   *  but not the store. */
  readonly homeDir?: string
  /** ADR-0557 — working directory the LEGACY `<cwd>/.quanta/memory.sqlite`
   *  is probed under. Defaults to `process.cwd()` (the exact directory the
   *  pre-0557 relative default resolved against). */
  readonly cwd?: string
  /** ADR-0557 — attributed notice sink for the two store-level events
   *  (legacy file honored / sqlite open failed ⇒ volatile fallback). Defaults
   *  to `logger.warn`; never swallowed. */
  readonly onStoreNotice?: (line: string) => void
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/** Resolve the `kind` argument to `buildStoreCore` from the env value
 *  and the default-ON contract. Accepts the legacy literal kinds
 *  ("sqlite" / "memory") AND the truthy/falsey set.
 *
 *  ADR-0557: the default-ON kind is the DURABLE `SqliteStore` at the
 *  home-scoped `~/.quanta/memory/memory.sqlite`. Before 0557 the default was
 *  the volatile `InMemoryStore`, which — measured — persisted nothing across
 *  launches (`persistSession` wrote into a Map that died with the process), so
 *  "memory learning default-ON" learned nothing durable; and the only durable
 *  path was a cwd-relative `.quanta/memory.sqlite` that crashed boot in any
 *  repo without a `.quanta/` dir. The session-memory (B) and consolidator (C)
 *  systems already wrote under `~/.quanta/memory/` on every launch, so the
 *  home-scoped default adds no new disk location. The volatile kind stays
 *  available as an EXPLICIT `QUANTA_MEMORY=memory`. */
const resolveStoreKind = (raw: string | undefined): MemoryStoreKind | undefined => {
  if (raw === undefined) return "sqlite"
  const v = raw.trim().toLowerCase()
  // Explicit kinds — pass through verbatim (`memory` is the explicit volatile).
  if (v === "sqlite" || v === "memory") return v
  // Falsey set — disable store entirely (legacy default-OFF escape hatch).
  if (v === "0" || v === "false" || v === "off" || v === "no") return undefined
  // Truthy set (incl. empty string, incl. the CLI seed `"1"`) — durable.
  if (parseEnvFlag(raw, /* defaultOn */ true)) return "sqlite"
  return undefined
}

/** ADR-0557 — resolve the sqlite path for one session: explicit
 *  (`override.storePath` > `QUANTA_MEMORY_PATH`) > legacy cwd file (if it
 *  exists) > home default. Home: `override.homeDir` > `quantaHomeDirFrom(env)`
 *  (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`, pure w.r.t. the injected env).
 *  Cwd: `override.cwd` >
 *  `process.cwd()` (the directory the pre-0557 relative default resolved
 *  against). The result is reported on the slot for the sqlite kind so
 *  surfaces name the file the store actually opened. */
const resolveSessionStorePath = (
  env: NodeJS.ProcessEnv,
  override: MemorySessionOverride | undefined,
): StorePathResolution => {
  // The QUANTA home, not the OS home. This read `env.HOME ?? homedir()`, so memory
  // was the one plane a relocated `QUANTA_HOME` / `QUANTA_CONFIG_DIR` did not move:
  // sessions and knobs followed it and the store stayed in the developer's real home.
  // `quantaHomeDirFrom({})` is `~/.quanta`, so the default path is unchanged.
  return resolveStorePath({
    homeDir: override?.homeDir ?? quantaHomeDirFrom(env),
    cwd: override?.cwd ?? process.cwd(),
    explicitPath: override?.storePath ?? env.QUANTA_MEMORY_PATH,
  })
}

/** ADR-0557 — open the store for a resolved kind, never letting a sqlite
 *  open failure (read-only home, EACCES on mkdir, …) kill the session: the
 *  failure is ATTRIBUTED through `notice` and the store falls back to the
 *  volatile kind, so the `kind` the slot reports stays the truth (the banner
 *  then honestly prints `kind=memory (volatile)`). */
const openStoreWithFallback = (
  kind: MemoryStoreKind,
  storePath: string,
  notice: (line: string) => void,
): { store: PersistentStorePort | undefined; kind: MemoryStoreKind } => {
  try {
    return { store: buildStoreCore({ kind, path: storePath }), kind }
  } catch (e) {
    notice(
      `memory store: could not open sqlite at ${storePath} (${errMessage(e)}); ` +
        "falling back to the volatile in-memory store for this session (nothing will be kept across restarts)",
    )
    return { store: new InMemoryStore(), kind: "memory" }
  }
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
 * Resolve the memory slots (store + config) for one session.
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
  // to ALL slots OFF — the "one knob = legacy off" contract (mirrors the
  // storeDisabled hard path above).
  if (kind === undefined) return {}
  const notice = override?.onStoreNotice ?? ((line: string) => logger.warn(line))
  const resolved = resolveSessionStorePath(env, override)
  // The legacy branch is honest, not silent: one attributed line names both
  // paths and the `mv` that migrates (only when the sqlite kind will open it).
  if (kind === "sqlite" && resolved.legacyNotice !== undefined) notice(resolved.legacyNotice)
  const opened = openStoreWithFallback(kind, resolved.path, notice)
  const store = opened.store
  const config = resolveMemoryConfigFromEnv(env, store, override)
  return {
    ...(store !== undefined ? { store, kind: opened.kind } : {}),
    ...(store !== undefined && opened.kind === "sqlite" ? { storePath: resolved.path } : {}),
    ...(config !== undefined ? { config } : {}),
  }
}
