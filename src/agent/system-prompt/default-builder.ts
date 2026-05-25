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

import type { PersonaKind } from "../persona"
import { buildSystemPrompt } from "../prompt"
import type { AgentMode as PromptPackMode } from "../prompt-rules"
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
  } = { identity: variant.identity }
  if (opts.persona !== undefined) promptOpts.persona = opts.persona
  if (opts.promptPack !== undefined) promptOpts.promptPack = opts.promptPack
  return buildSystemPrompt(undefined, promptOpts)
}
