/**
 * SOTA++ knob framework — core types.
 *
 * Cross-surface, layered (CLI > session > env > config > preset > default),
 * registry-driven feature flags. Each knob is a self-contained record that
 *   - parses a raw string into a typed value,
 *   - folds that value into a baseline `AgentConfig` (PURE),
 *   - declares which surfaces it applies to + relationships (conflict /
 *     require) so the resolver can validate.
 *
 * Closed-port invariant: `resolveKnobs` consumes ONLY the data passed in via
 * `ResolveArgs` — no process.env / fs reads. The surface entry assembles the
 * inputs and feeds them in.
 *
 * Byte-identical invariant: a knob that is not registered, or whose value
 * does not resolve, never touches the AgentConfig — `applyKnobs` is the only
 * call site that mutates and it is folded over RESOLVED knobs only.
 */

import type { AgentConfig } from "@/agent"
import type { Instance } from "@/runner/batch/types"

/** Surface = where the agent loop is being driven from. */
export type Surface = "bench" | "cli" | "agent-batch" | "agent-interactive" | "ide"

/** Per-application context handed to `Knob.apply`. */
export interface ApplyContext {
  readonly surface: Surface
  readonly instance?: Instance
  readonly sandbox?: string
}

/** Knob taxonomy — used for grouping in `--help` listings + matrix budget. */
export type KnobCategory = "agent" | "tool" | "hint" | "verify" | "validation"

/**
 * A single knob. Generic over `T` (the parsed value type).
 *
 * `parse` returns `undefined` when the raw string does NOT denote a value the
 * knob recognizes (e.g. `"0"` for a boolean knob — caller falls through to
 * the next layer instead of treating it as "off"). To force a hard error, the
 * parse function may throw; the resolver wraps it in `KnobParseError`.
 *
 * `apply` is PURE — it takes the baseline config and returns a new config.
 * Implementations MUST NOT mutate `cfg` or its sub-objects.
 */
export interface Knob<T = unknown> {
  readonly id: string // kebab-case, stable
  readonly envKey: string // ENV variable name
  readonly cliFlag?: string // optional --flag form (default: --knob <id>=<val>)
  readonly category: KnobCategory
  readonly surfaces: readonly Surface[] // which surfaces apply this
  readonly parse: (raw: string | undefined) => T | undefined
  readonly apply: (cfg: AgentConfig, value: T, ctx: ApplyContext) => AgentConfig
  readonly describe: string // one-line summary for `--help`
  readonly help?: string // multi-line long help
  /** Human UNIT of the parsed value, so "5" is never bare. e.g. "turns" /
   *  "samples" / "candidates" / "rounds" / "retries" / "mode". OMITTED ⇒ the
   *  value is a boolean ON/OFF flag (rendered "on"). Surfaced in knobsForReport
   *  (`display`) and the preset tables so the number always carries its unit. */
  readonly unit?: string
  readonly source?: string // ADR / paper reference
  readonly conflicts?: readonly string[] // ids that MUST NOT co-activate
  readonly requires?: readonly string[] // ids that MUST also be active
  readonly costMultiplier?: number // matrix budget; default 1
  readonly hotToggleable?: boolean // mid-session change ok? default false
  readonly default?: T | undefined
}

/** Resolved value with source tracking (for telemetry / debug). */
export interface KnobValue<T> {
  readonly value: T
  readonly source: "cli" | "session" | "env" | "config-file" | "preset" | "default"
}

/**
 * Map of resolved knob values keyed by knob id. Always frozen at the public
 * surface (we return `ReadonlyMap`).
 */
export type KnobValueMap = ReadonlyMap<string, KnobValue<unknown>>

/**
 * Type alias for the widest knob shape stored in registries / maps.
 *
 * Under `exactOptionalPropertyTypes` a `Knob<boolean>` is NOT assignable to
 * `Knob<unknown>`: the `default?: T | undefined` property becomes invariant
 * in T when EOPT is on (the optional marker turns the apparent covariance
 * into invariance). Authors must therefore widen explicitly when adding to
 * a registry-shaped map. We expose an `asAnyKnob` helper that ALSO checks
 * the surface invariant at runtime so the widening never hides a bug.
 */
export type AnyKnob = Knob<unknown>

/** Safe upcast for storing typed knobs in `Map<string, AnyKnob>`. */
export const asAnyKnob = <T>(k: Knob<T>): AnyKnob => k as unknown as AnyKnob

/**
 * Inputs to `resolveKnobs`. ALL inputs are plain data — no fs / env reads
 * happen inside resolve. The surface entry is responsible for assembling
 * them. This is the "closed port" guarantee.
 */
export interface ResolveArgs {
  readonly surface: Surface
  /** Filtered registry (typically `knobsForSurface(surface)`). */
  readonly knobs: ReadonlyMap<string, AnyKnob>
  /** Parsed `--knob id=val` map. */
  readonly cliArgs?: Record<string, string>
  /** CLI REPL `/knobs set` overrides. */
  readonly sessionOverrides?: Record<string, string>
  /** Snapshot of `process.env` (surface passes it in). */
  readonly envVars?: NodeJS.ProcessEnv
  /** `~/.quanta/knobs.json` user defaults. */
  readonly configFile?: Record<string, string>
  /** `--knobs-preset <name>`. */
  readonly preset?: string
}

/** Thrown when two active knobs declare each other in `conflicts`. */
export class KnobConflictError extends Error {
  readonly conflicts: readonly (readonly [string, string])[]
  constructor(conflicts: readonly (readonly [string, string])[]) {
    super(`knob conflicts: ${conflicts.map(([a, b]) => `${a}<->${b}`).join(", ")}`)
    this.name = "KnobConflictError"
    this.conflicts = conflicts
  }
}

/** Thrown when an active knob's `requires` is not satisfied. */
export class KnobMissingRequiredError extends Error {
  readonly knobId: string
  readonly missingRequired: string
  constructor(knobId: string, missingRequired: string) {
    super(`knob "${knobId}" requires "${missingRequired}" to be active`)
    this.name = "KnobMissingRequiredError"
    this.knobId = knobId
    this.missingRequired = missingRequired
  }
}

/** Thrown when a knob's `parse` throws on a non-empty raw value. */
export class KnobParseError extends Error {
  readonly knobId: string
  readonly raw: string
  constructor(knobId: string, raw: string) {
    super(`knob "${knobId}" parse failed for value "${raw}"`)
    this.name = "KnobParseError"
    this.knobId = knobId
    this.raw = raw
  }
}
