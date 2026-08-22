/**
 * ADR-0339 — Plugin-declared skill set resolver + union primitives.
 *
 * Two pure primitives that wire a plugin manifest's `skills[]` (ADR-0336
 * `PluginManifest.skills?: readonly string[]`) onto the active-skills
 * channel (ADR-0321 typed event + ADR-0327 `TurnContextInput.activeSkills`).
 *
 * Composition (illustrative — done in a composition root after ADR-0338
 * launcher lands):
 *
 *   const pluginResolved = resolvePluginSkillsForActivation(
 *     manifest.skills ?? [],
 *     { registry: skillRegistry, emit: store.append },
 *     { trigger: "auto", at: Date.now(), turnId },
 *   )
 *   const merged = unionActiveSkills(cfg.activeSkills, pluginResolved)
 *   // pass `merged` as TurnContextInput.activeSkills
 *
 * Both primitives are NO-THROW. Composition-root failure cannot break
 * the agent loop.
 *
 * # Caller-override precedence
 *
 * {@link unionActiveSkills} dedupes by `name`; CALLER (existing) entries
 * WIN over plugin entries. Rationale: the caller's slice (host config,
 * user-pinned skill, mention-resolver injection) is closer to the user
 * intent than a plugin's declared list. A plugin that wants to provide
 * a "preferred" description for a name the caller already has must
 * accept the caller's description — same posture as ADR-0332's install
 * helper ("a caller-pre-populated slot is NEVER overwritten"). This
 * symmetry is intentional: plugin extension is a SUPPLEMENT, not an
 * override.
 *
 * # Drop-on-miss
 *
 * Skills referenced by `manifest.skills` but absent from the registry
 * are silently dropped. A plugin may declare future / optional skills
 * (the registry is a session snapshot — ADR-0134), or a typo may slip
 * through plugin validation. Crashing on first miss would brick the
 * plugin; a noisy log is the composition root's call, not this
 * primitive's.
 */

import type {
  ActiveSkillDescriptor,
  PluginSkillExtensionConfig,
  SkillActivationEventLike,
} from "./types"

/**
 * Resolve a plugin's declared skill names against the registry and
 * project them onto active-skill descriptors. Optionally fires
 * `skill_activation` events (trigger defaults to `"auto"` — the plugin
 * activation IS the trigger).
 *
 * - `skillNames`: the raw `manifest.skills ?? []` list. Order preserved.
 * - `cfg.registry`: ADR-0330 read-only port. Lookup is NO-THROW (the
 *   port already wraps internal failures and returns `null`); we treat
 *   any thrown value defensively anyway.
 * - `cfg.emit`: optional hook fired once per RESOLVED (registry-hit)
 *   skill. NEVER awaited; any throw is swallowed.
 * - `opts.trigger`: defaults to `"auto"` — set `"user"` / `"system"`
 *   when the caller has stronger signal than "side-effect of plugin
 *   activation".
 * - `opts.at`: epoch ms for the emitted events. Defaults to
 *   `Date.now()` so callers without a clock-port still emit valid
 *   events. Tests pass an explicit `at` for determinism.
 * - `opts.turnId`: optional turn correlation. Mirrors the
 *   `SkillActivationEvent.turnId?` shape (ADR-0320).
 *
 * NO-THROW: every external call (lookup, emit) is wrapped in try/catch.
 * On any internal failure the function returns whatever it has resolved
 * so far PLUS continues with the remaining names. Empty input ⇒ `[]`.
 *
 * @returns A new readonly array of descriptors, in input order, with
 *          registry-miss entries dropped. Never returns `undefined`.
 */
/** Lookup one name on the read-only registry, normalized to a clean
 *  descriptor (or `null`). NO-THROW: swallows hostile-registry throws.
 *  Kept module-private; the function-level complexity budget (15) is
 *  why we factor this out of the main loop. */
const lookupOne = (
  registry: PluginSkillExtensionConfig["registry"],
  name: string,
): ActiveSkillDescriptor | null => {
  try {
    const hit = registry.lookup(name)
    if (hit === null) return null
    if (typeof hit.name !== "string" || typeof hit.description !== "string") return null
    return { name: hit.name, description: hit.description }
  } catch {
    return null
  }
}

/** Build a `SkillActivationEventLike` for `descriptor` with the given
 *  trigger/at/turnId. Caller-supplied `turnId` is dropped when
 *  `undefined` (exactOptionalPropertyTypes-friendly emission). */
const buildEvent = (
  descriptor: ActiveSkillDescriptor,
  trigger: "user" | "auto" | "system",
  at: number,
  turnId: string | undefined,
): SkillActivationEventLike =>
  turnId === undefined
    ? { kind: "skill_activation", skillId: descriptor.name, trigger, at }
    : { kind: "skill_activation", skillId: descriptor.name, trigger, at, turnId }

/** NO-THROW emit wrapper. */
const safeEmit = (
  emit: ((event: SkillActivationEventLike) => void) | undefined,
  event: SkillActivationEventLike,
): void => {
  if (emit === undefined) return
  try {
    emit(event)
  } catch {
    // Swallow — descriptor still flows; emit is a side channel.
  }
}

export const resolvePluginSkillsForActivation = (
  skillNames: readonly string[],
  cfg: PluginSkillExtensionConfig,
  opts?: {
    readonly at?: number
    readonly turnId?: string
    readonly trigger?: "user" | "auto" | "system"
  },
): readonly ActiveSkillDescriptor[] => {
  // Defensive guard — empty / non-array short-circuits with no emit.
  if (!Array.isArray(skillNames) || skillNames.length === 0) {
    return []
  }

  const trigger = opts?.trigger ?? "auto"
  const at = typeof opts?.at === "number" ? opts.at : Date.now()
  const turnId = opts?.turnId
  const emit = cfg.emit

  const resolved: ActiveSkillDescriptor[] = []
  for (const name of skillNames) {
    const descriptor = lookupOne(cfg.registry, name)
    if (descriptor === null) continue
    resolved.push(descriptor)
    safeEmit(emit, buildEvent(descriptor, trigger, at, turnId))
  }
  return resolved
}

/**
 * Union an existing active-skills list with a plugin-resolved list,
 * deduping by `name`. CALLER (existing) entries win on collision.
 *
 * Order:
 *   1. existing entries first (preserves caller's order, byte-identical
 *      when `pluginResolved` is empty)
 *   2. plugin entries APPENDED in their input order (with collisions
 *      removed)
 *
 * NO-THROW. Handles `existing === undefined`. Returns a NEW array — never
 * mutates either input. When both are empty the result is the
 * canonically-empty `[]` (a fresh array each call so callers can't
 * accidentally share state via the result).
 */
export const unionActiveSkills = (
  existing: readonly ActiveSkillDescriptor[] | undefined,
  pluginResolved: readonly ActiveSkillDescriptor[],
): readonly ActiveSkillDescriptor[] => {
  const existingArr: readonly ActiveSkillDescriptor[] = Array.isArray(existing) ? existing : []
  // Build a name set from existing so we can SKIP collisions in plugin
  // entries (caller wins). Uses a plain Set — no Map needed since we
  // don't compare descriptions; presence-by-name is the only check.
  const seen = new Set<string>()
  for (const e of existingArr) {
    if (e !== null && e !== undefined && typeof e.name === "string") {
      seen.add(e.name)
    }
  }
  const out: ActiveSkillDescriptor[] = []
  // Existing first, byte-identical when plugin list is empty.
  for (const e of existingArr) {
    if (e !== null && e !== undefined && typeof e.name === "string") {
      out.push(e)
    }
  }
  for (const p of pluginResolved) {
    if (p === null || p === undefined || typeof p.name !== "string") continue
    if (seen.has(p.name)) continue
    seen.add(p.name)
    out.push(p)
  }
  return out
}
