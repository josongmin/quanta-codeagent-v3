/**
 * Preset → role-model resolver adapter (§9.6 opusplan activation).
 *
 * The `/presets` slash mutates a live `StickyPresetResolver` (`ctx.presets`);
 * the agent loop's role→model resolution consults an `AgentConfig.roleModelResolver`
 * (ADR-0256, `resolveChildLlm` in `@/agent/subagent-runner-overrides`). This
 * adapter bridges the two so a SELECTED preset actually changes which model a
 * role runs — WITHOUT duplicating the preset registry (it delegates to the SAME
 * resolver instance the slash command mutates).
 *
 * Precedence, matching the model-preset slice's documented layering ("the preset
 * supplies the per-role default, which an explicit role override can still
 * beat"):
 *   1. An explicit per-role override recorded via {@link RoleModelResolver.setOverride}
 *      on THIS adapter (its own in-memory map) — wins.
 *   2. The selected preset's role binding (or the preset's `defaultModel`).
 *   3. When NO preset is selected AND no override exists ⇒ the caller's
 *      `defaultModel` argument VERBATIM (Default-OFF byte-identity: with no
 *      preset picked, `resolve` returns exactly what the loop passed in, so the
 *      loop is byte-identical to the no-resolver path).
 *
 * The adapter is a THIN wrapper: `select`/`clear` are NOT on the RoleModelResolver
 * surface, so they are driven exclusively by `/presets` through the shared
 * `StickyPresetResolver` reference — this adapter only READS `presets.resolve`
 * plus its own override map. NO-THROW (RoleModelResolver contract): an unknown
 * role string falls through to the preset default / caller default; an empty
 * override modelId is rejected via the typed `SetOverrideResult` (never a silent
 * `""` poison).
 */

import type { StickyPresetResolver } from "@/llm"
import { defaultRoleModelResolver, type RoleModelResolver } from "@/llm/role-model-override"

/**
 * Wrap a shared {@link StickyPresetResolver} as a {@link RoleModelResolver} the
 * loop consumes. The SAME `presets` instance is handed to `ctx.presets` so a
 * `/presets <name>` select is observed here on the NEXT role resolution.
 *
 * NO DUPLICATION: the explicit-override half of the port (the map + typed
 * `setOverride`/`clearOverride`/`listOverrides`) is DELEGATED to the SSOT
 * {@link defaultRoleModelResolver} (ADR-0256) — this adapter does NOT re-roll a
 * second override map. It only overrides `resolve` to interpose the preset:
 * where the base resolver would fall through to the caller's `defaultModel`, we
 * substitute the preset's per-role binding (or its default) FIRST.
 *
 * Precedence (composed at THIS root, not inside either resolver — the documented
 * ADR-0256 §Consequences pattern):
 *   1. explicit role override (`inner.resolve` returns it) — wins;
 *   2. else the selected preset's binding / default;
 *   3. else NO preset selected ⇒ the caller's `defaultModel` VERBATIM.
 * The layering is achieved by feeding the preset resolution AS the `defaultModel`
 * into the inner override resolver: `inner.resolve(role, presets.resolve(role, defaultModel))`.
 * When a role HAS an override, the inner returns it (the preset default arg is
 * ignored); otherwise the inner returns the preset resolution. When NO preset is
 * selected, `presets.resolve` returns `defaultModel` verbatim, so with neither an
 * override nor a preset the result is exactly `defaultModel` (Default-OFF
 * byte-identity).
 */
export const buildPresetRoleModelResolver = (presets: StickyPresetResolver): RoleModelResolver => {
  const inner = defaultRoleModelResolver()
  return {
    // Interpose the preset UNDER any explicit override by passing the preset
    // resolution as the inner resolver's fallback (see the precedence note).
    resolve: (role, defaultModel) => inner.resolve(role, presets.resolve(role, defaultModel)),
    // The override half is the SSOT resolver's verbatim surface (no re-roll).
    setOverride: (role, modelId) => inner.setOverride(role, modelId),
    clearOverride: (role) => inner.clearOverride(role),
    listOverrides: () => inner.listOverrides(),
  }
}
