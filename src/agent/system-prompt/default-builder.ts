/**
 * Default mode-variant registry + system-prompt builder helper (ADR-0211).
 *
 * Closed-port default-impl: returns a registry whose `variantFor(mode)`
 * looks up the bundled {@link DEFAULT_MODE_VARIANTS} table; an optional
 * `overrides` map shallow-replaces entries at construction time.
 *
 * Pure: the factory and the returned registry take no IO, no clock, no
 * global mutable state. Returned arrays are defensive copies so a caller
 * mutating the result cannot poison subsequent lookups.
 *
 * The `buildSystemPromptForMode` helper threads the registry's variant
 * through the existing `buildSystemPrompt({ identity })` seam — that
 * keeps this slice ADDITIVE: callers that do not invoke it get a
 * byte-identical prompt (same `INTRO_LINES → … → BODY_AFTER_PROMPT_PACK`
 * pipeline as today).
 */

import { isTruthyToken, type PromptSurfaceProfileSnapshot } from "@/shared"
import type { PersonaKind } from "../persona"
import { buildSystemPrompt, type EnvironmentPosture } from "../prompt"
import type { AgentMode as PromptPackMode } from "../prompt-rules"
import type { VerifyStrategy } from "../prompt-rules/verify-strategy"
import type { PromptStyle } from "../prompt-style"
import type { AgentMode as RunMode } from "../run-mode/types"
import { DEFAULT_MODE_VARIANTS, UNKNOWN_MODE_VARIANT } from "./mode-variants"
import {
  assertValidVariantLines,
  MODE_VARIANT_KEYS,
  type ModeVariant,
  type ModeVariantKey,
  type SystemPromptVariantRegistry,
} from "./port"

/** Build the default {@link SystemPromptVariantRegistry}. `overrides` is an
 *  optional partial map keyed by {@link ModeVariantKey}; supplied entries
 *  replace the default table for THAT mode only — every absent key falls
 *  through to {@link DEFAULT_MODE_VARIANTS}. Each override array is validated
 *  by {@link assertValidVariantLines} once at construction time so a forged
 *  newline-bearing or empty entry surfaces immediately, not deep inside the
 *  prompt-build path. */
export const defaultModeVariantRegistry = (
  overrides?: Partial<Record<ModeVariantKey, readonly string[]>>,
): SystemPromptVariantRegistry => {
  const table: Record<ModeVariantKey, readonly string[]> = {
    default: DEFAULT_MODE_VARIANTS.default,
    plan: DEFAULT_MODE_VARIANTS.plan,
    review: DEFAULT_MODE_VARIANTS.review,
    audit: DEFAULT_MODE_VARIANTS.audit,
    architect: DEFAULT_MODE_VARIANTS.architect,
    editor: DEFAULT_MODE_VARIANTS.editor,
  }
  if (overrides !== undefined) {
    for (const mode of MODE_VARIANT_KEYS) {
      const o = overrides[mode]
      if (o !== undefined) {
        table[mode] = assertValidVariantLines(mode, o)
      }
    }
  }
  return {
    variantFor(mode: ModeVariantKey): ModeVariant {
      const lines = (table as Record<string, readonly string[] | undefined>)[mode]
      if (lines === undefined) {
        // Defensive copy so caller mutation cannot affect next lookup.
        return {
          mode: UNKNOWN_MODE_VARIANT.mode,
          identity: [...UNKNOWN_MODE_VARIANT.identity],
        }
      }
      return { mode, identity: [...lines] }
    },
  }
}

/** Options for {@link buildSystemPromptForMode}. Same shape as the second
 *  `buildSystemPrompt` argument PLUS a required `mode` discriminator. The
 *  registry is optional — absent ⇒ {@link defaultModeVariantRegistry} is
 *  used. */
export interface BuildSystemPromptForModeOpts {
  readonly mode: ModeVariantKey
  readonly registry?: SystemPromptVariantRegistry
  readonly persona?: PersonaKind
  readonly promptPack?: PromptPackMode
  /** Environment posture (RFC jul-2) — a SEPARATE axis from `mode` (which is the
   *  task-posture `ModeVariantKey`). Forwarded verbatim to `buildSystemPrompt`.
   *  Absent / `"frozen"` ⇒ byte-identical to today. Prompt-text-only. */
  readonly envPosture?: EnvironmentPosture
  /** jul-4 verify-strategy axis + jul-6 render-style axis — forwarded verbatim to
   *  `buildSystemPrompt` so a surface routed through this builder can render them
   *  too (they were previously DROPPED here — a knob-looks-wired-but-inert
   *  foot-gun). Absent ⇒ no verify rule / flat style, byte-identical. */
  readonly verifyStrategy?: VerifyStrategy
  readonly promptStyle?: PromptStyle
}

/** Build a mode-aware system prompt. Resolves the variant for `mode` via the
 *  registry (default = {@link defaultModeVariantRegistry}) and threads the
 *  identity lines through `buildSystemPrompt({ identity })`. Pure — no IO,
 *  no clock, no env reads. Callers that want byte-identical legacy behavior
 *  should keep calling `buildSystemPrompt()` directly with no `identity`
 *  field; this helper is the OPT-IN seam. */
export const buildSystemPromptForMode = (opts: BuildSystemPromptForModeOpts): string => {
  const registry = opts.registry ?? defaultModeVariantRegistry()
  const variant = registry.variantFor(opts.mode)
  // exactOptionalPropertyTypes-strict: only spread keys that are defined.
  // `buildSystemPrompt` accepts a single optional opts arg — assemble it
  // piecewise so absent persona / promptPack do NOT collide with the strict
  // optional shape.
  const promptOpts: {
    persona?: PersonaKind
    promptPack?: PromptPackMode
    identity?: readonly string[]
    envPosture?: EnvironmentPosture
    verifyStrategy?: VerifyStrategy
    promptStyle?: PromptStyle
  } = { identity: variant.identity }
  if (opts.persona !== undefined) promptOpts.persona = opts.persona
  if (opts.promptPack !== undefined) promptOpts.promptPack = opts.promptPack
  if (opts.envPosture !== undefined) promptOpts.envPosture = opts.envPosture
  if (opts.verifyStrategy !== undefined) promptOpts.verifyStrategy = opts.verifyStrategy
  if (opts.promptStyle !== undefined) promptOpts.promptStyle = opts.promptStyle
  return buildSystemPrompt(undefined, promptOpts)
}

export interface BuildSystemPromptForRunModeOpts {
  readonly runMode: RunMode
  readonly cwd?: string
  readonly persona?: PersonaKind
  readonly identity?: readonly string[]
  readonly envPosture?: EnvironmentPosture
  /** jul-4 verify-strategy + jul-6 render-style axes — forwarded to
   *  `buildSystemPrompt` (previously dropped on this seam). Absent ⇒ byte-identical. */
  readonly verifyStrategy?: VerifyStrategy
  readonly promptStyle?: PromptStyle
}

/**
 * jul-9 `QUANTA_ENV_DEFAULT` CLI knob (default-OFF, byte-identical when unset/falsy).
 * ON (truthy token) ⇒ the general CLI's default env posture becomes `"default"` — a general
 * LOCAL-DEV machine where installing is permitted — instead of `"frozen"` (SWE-bench
 * "don't install / stop-when-env-blocked", which is the wrong posture for a developer at
 * their OWN repo). PURE: reads only the injected `env` (no `process.env`, no clock). An
 * EXPLICIT `envPosture` from a caller still wins; this only sets the otherwise-unset default.
 * Efficacy is measure-first (opt-in) — OFF stays byte-identical so there is zero regression.
 */
export const resolveCliDefaultEnvPosture = (
  env: Record<string, string | undefined>,
): EnvironmentPosture => (isTruthyToken(env.QUANTA_ENV_DEFAULT) ? "default" : "frozen")

export const promptSurfaceProfileForRunMode = (
  runMode: RunMode,
  opts: {
    readonly envPosture?: PromptSurfaceProfileSnapshot["envPosture"]
    readonly verifyStrategy?: PromptSurfaceProfileSnapshot["verifyStrategy"]
  } = {},
): PromptSurfaceProfileSnapshot => ({
  envPosture: opts.envPosture ?? "frozen",
  promptPack: runMode,
  verifyStrategy: opts.verifyStrategy ?? "none",
})

export const buildSystemPromptForRunMode = (opts: BuildSystemPromptForRunModeOpts): string => {
  const promptOpts: {
    persona?: PersonaKind
    promptPack: PromptPackMode
    identity?: readonly string[]
    envPosture?: EnvironmentPosture
    verifyStrategy?: VerifyStrategy
    promptStyle?: PromptStyle
  } = { promptPack: opts.runMode }
  if (opts.persona !== undefined) promptOpts.persona = opts.persona
  if (opts.identity !== undefined) promptOpts.identity = opts.identity
  if (opts.envPosture !== undefined) promptOpts.envPosture = opts.envPosture
  if (opts.verifyStrategy !== undefined) promptOpts.verifyStrategy = opts.verifyStrategy
  if (opts.promptStyle !== undefined) promptOpts.promptStyle = opts.promptStyle
  return buildSystemPrompt(opts.cwd, promptOpts)
}
