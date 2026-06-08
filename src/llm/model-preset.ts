/**
 * §9.6 — opusplan-style sticky model PRESET (PURE, default-OFF).
 *
 * A model preset is a NAMED, curated bundle that maps a logical role/phase to a
 * concrete model, applied STICKILY for the run. Claude Code's `opusplan` is the
 * canonical example: a deep-reasoning model (Opus) during plan-mode and a fast
 * model (Sonnet) for execution. The operator picks the preset BY NAME, and the
 * choice persists until cleared.
 *
 * This is deliberately distinct from the two pre-existing model-selection axes:
 *   - `role-model-override` (ADR-0256) stores AD-HOC per-role picks the user set
 *     individually; a preset is a curated multi-role RECIPE chosen by one name.
 *   - sticky-model (ADR-0212) makes the user's ONE chosen model persist across
 *     turns; a preset binds DIFFERENT models to different roles within the run.
 * A composition root can layer them: a preset supplies the per-role default,
 * which an explicit role override can still beat.
 *
 * V1 scope (this slice): a pure preset registry + a sticky resolver. NO host
 * wiring, NO CLI slash command — importing this changes no behaviour and
 * nothing resolves a preset until a caller opts in by name (Default-OFF, per
 * the lane brief: "preset + batches client core, default-OFF"). The model ids
 * are the current canonical slugs (see the claude-api skill model table).
 *
 * NO-THROW public surface: an unknown preset name ⇒ `undefined` (resolve) or a
 * typed `{ok:false}` (select); a type-erased role string falls through to the
 * preset `defaultModel`. Reuses the `Role` axis from `role-model-override` so
 * the two compose without a second enum.
 */

import { QuantaError } from "@/shared"
import type { ModelId, Role } from "./role-model-override/types"

/**
 * A named preset. `roles` is a partial map (a preset need not bind every role);
 * `defaultModel` is the binding fallback for any role the preset does not name.
 * `defaultModel` MUST be non-empty (a preset with no default is meaningless).
 */
export interface ModelPreset {
  /** Stable preset name the operator selects (e.g. `"opusplan"`). */
  readonly name: string
  /** One-line summary for `/presets` / `--help` discoverability. */
  readonly describe: string
  /** Binding fallback for any role not present in {@link roles}. Non-empty. */
  readonly defaultModel: ModelId
  /** Per-role model bindings. Partial — absent roles use {@link defaultModel}. */
  readonly roles: Partial<Record<Role, ModelId>>
}

/**
 * Built-in presets. `opusplan` mirrors Claude Code: Opus for the deep-reasoning
 * plan-writer/reviewer roles, Sonnet for the fast executor/explorer/default.
 * The constant is FROZEN so a consumer cannot mutate the shared catalog by
 * reference.
 */
export const BUILTIN_MODEL_PRESETS: readonly ModelPreset[] = Object.freeze([
  {
    name: "opusplan",
    describe: "Opus for planning/review, Sonnet for execution (Claude-Code opusplan).",
    defaultModel: "claude-sonnet-4-6",
    roles: {
      "plan-writer": "claude-opus-4-8",
      reviewer: "claude-opus-4-8",
      executor: "claude-sonnet-4-6",
      explorer: "claude-sonnet-4-6",
    },
  },
])

/** Result of {@link StickyPresetResolver.select} — symmetric with the
 *  role-override `SetOverrideResult` shape. */
export type SelectPresetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PresetError }

/** Preset-selection rejection (currently `unknown-preset`), modeled as a
 *  QuantaError subclass so future codes attach without a breaking shape. */
export class PresetError extends QuantaError {}

/** Resolve a preset by name from the built-ins (+ any `extra` presets). Returns
 *  `undefined` for an unknown name (NO-THROW — names arrive from type-erased
 *  surfaces). `extra` entries with a name colliding a built-in SHADOW the
 *  built-in (caller-supplied wins). */
export const resolveModelPreset = (
  name: string,
  extra: readonly ModelPreset[] = [],
): ModelPreset | undefined => {
  // extra first so a caller override shadows a built-in of the same name.
  for (const p of extra) if (p.name === name) return p
  for (const p of BUILTIN_MODEL_PRESETS) if (p.name === name) return p
  return undefined
}

/** Enumerate every preset (built-ins + `extra`, caller entries first so a
 *  shadowing override is the one listed). For discoverability surfaces. */
export const listModelPresets = (extra: readonly ModelPreset[] = []): readonly ModelPreset[] => {
  const seen = new Set<string>()
  const out: ModelPreset[] = []
  for (const p of [...extra, ...BUILTIN_MODEL_PRESETS]) {
    if (seen.has(p.name)) continue
    seen.add(p.name)
    out.push(p)
  }
  return out
}

/** Resolve the model a preset binds to `role`, falling back to the preset
 *  `defaultModel` when the role is unmapped. NO-THROW: a type-erased role
 *  string that is not a known key simply takes the default. */
export const resolveModelForRole = (preset: ModelPreset, role: Role): ModelId => {
  const bound = preset.roles[role]
  return bound !== undefined && bound !== "" ? bound : preset.defaultModel
}

/**
 * Sticky preset resolver — remembers ONE selected preset for the run and
 * resolves a role to its bound model, falling back to the caller's verbatim
 * fallback when NO preset is selected (Default-OFF byte-identity). Pure
 * in-memory; persistence is a separate concern.
 */
export interface StickyPresetResolver {
  /** Select a preset by name. Unknown name ⇒ typed `{ok:false}` and the sticky
   *  selection is UNCHANGED (a bad name never clears a good selection). */
  select(name: string): SelectPresetResult
  /** Clear the sticky selection (resolve then returns the fallback verbatim). */
  clear(): void
  /** The currently-selected preset, or `undefined` when none is selected. */
  selected(): ModelPreset | undefined
  /** Resolve the effective model for `role`. When a preset is selected, the
   *  preset binding (or its default) wins; otherwise the caller's `fallback`
   *  is returned VERBATIM. */
  resolve(role: Role, fallback: ModelId): ModelId
}

/** Construct a {@link StickyPresetResolver}. `extra` registers custom presets
 *  alongside (and shadowing, on name collision) the built-ins. */
export const createStickyPresetResolver = (
  extra: readonly ModelPreset[] = [],
): StickyPresetResolver => {
  let current: ModelPreset | undefined
  return {
    select(name) {
      const preset = resolveModelPreset(name, extra)
      if (preset === undefined) {
        return {
          ok: false,
          error: new PresetError("unknown-preset", `unknown model preset: ${name}`),
        }
      }
      current = preset
      return { ok: true }
    },
    clear() {
      current = undefined
    },
    selected() {
      return current
    },
    resolve(role, fallback) {
      if (current === undefined) return fallback
      return resolveModelForRole(current, role)
    },
  }
}
