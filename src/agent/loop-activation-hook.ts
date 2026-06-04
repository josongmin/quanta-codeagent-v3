/**
 * ADR-0346 — Loop integration for ADR-0340 plugin activation trigger.
 *
 * `prepareTurnContext` (in `./loop.ts`) calls `resolvePluginActivationForTurn`
 * once per attempt, BEFORE `buildTurnContext`. The returned `resolvedSkills`
 * are unioned with the caller-supplied `activeSkills` via
 * {@link unionActiveSkills} (ADR-0339) so plugin-declared skills surface on
 * the active-skills channel for the same turn that the mention was parsed.
 *
 * Wiring closes the dangling ADR-0340 seam:
 *
 *   - ADR-0340 introduced `AgentConfig.activatePlugins?` but left invocation
 *     to the caller. With this hook in place, composition roots that set
 *     `cfg.activatePlugins` get per-turn activation FOR FREE — no extra
 *     surface code required.
 *   - ADR-0338 (`launchPluginMcpServers`) is invoked transitively by the
 *     activation handler the composition root assembled, so this hook is
 *     also the trigger for plugin MCP-server spawn (follow-up #3 of
 *     ADR-0338).
 *
 * Non-goals:
 *   - This module does NOT mutate `AgentConfig` (no new slot).
 *   - This module does NOT touch `@/agent/prompt` (`buildTurnContext`).
 *   - This module does NOT own MCP-handle lifetime — that stays with the
 *     composition root's `PluginMcpRegistry` (ADR-0338 lifetime contract).
 *
 * Slice fence:
 *   - imports `@/agent/mention-injection` (parseMentions + ParsedMention
 *     type) and `@/agent/plugin-skill-extension` (ActiveSkillDescriptor
 *     type) — both are pure leaf primitives by design.
 *   - imports `@/agent/plugin-activation-handler` ONLY for the
 *     AggregatedActivation type.
 *   - MUST NOT import `@/agent/loop`, `@/agent/dispatch`, `@/agent/prompt`
 *     to keep the slice acyclic — `loop.ts` imports US, not the reverse.
 *
 * NO-THROW invariants (per defence-in-depth):
 *   - `config.activatePlugins === undefined` ⇒ no work, empty resolvedSkills.
 *   - empty / missing user text ⇒ no work.
 *   - thrown `parseMentions` ⇒ swallow, empty resolvedSkills.
 *   - thrown `activatePlugins` ⇒ swallow, empty resolvedSkills.
 *   - any other failure ⇒ swallow.
 *
 *   This means absent / failing activation can NEVER break a turn. With
 *   `cfg.activatePlugins` absent the hook returns
 *   `{ resolvedSkills: [] }` so the caller's `unionActiveSkills` is a
 *   byte-identical pass-through (existing entries kept, no plugin entries
 *   appended).
 */

import type { ParsedMention } from "@/agent/mention-injection"
import type { AggregatedActivation } from "@/agent/plugin-activation-handler"
import { type ActiveSkillDescriptor, unionActiveSkills } from "@/agent/plugin-skill-extension"
import type { MetricEmitterPort } from "@/observability/codex-r2-metrics"
import type { ActiveSkillDeps, SkillMcpSession } from "@/skill/skill-mcp-deps"

/**
 * Narrow subset of `AgentConfig` that the hook reads. Kept structural so
 * tests can pass a 1-field object without conjuring an entire AgentConfig.
 *
 * `metricsEmitter` is an ADR-0360 structural side-channel — composition
 * roots (ADR-0358 §assemble.ts) may set
 * `(cfg as { metricsEmitter?: MetricEmitterPort }).metricsEmitter` to a
 * `MetricEmitterPort` (ADR-0352). Absent ⇒ per-turn activation telemetry
 * is OFF and the hook is byte-identical to the ADR-0346 baseline.
 */
export interface ActivationHookConfigLike {
  readonly activatePlugins?: (
    mentions: readonly ParsedMention[],
    opts?: { readonly turnId?: string },
  ) => Promise<AggregatedActivation>
  readonly metricsEmitter?: MetricEmitterPort
}

/**
 * Result shape — narrow on purpose. The caller only needs
 * `resolvedSkills` to union into `TurnContextInput.activeSkills`. Handles
 * are intentionally OMITTED here: their lifetime is owned by the
 * composition root's `PluginMcpRegistry` (ADR-0338), not the loop. The
 * underlying activation handler already retained them in the registry
 * before this function returned.
 */
export interface ResolvedPluginActivation {
  readonly resolvedSkills: readonly ActiveSkillDescriptor[]
}

const EMPTY: ResolvedPluginActivation = Object.freeze({
  resolvedSkills: Object.freeze([]) as readonly ActiveSkillDescriptor[],
})

/**
 * Convenience: union the caller's `activeSkills` with the plugin-resolved
 * skills returned by `resolvePluginActivationForTurn`, projecting the
 * `readonly ActiveSkillDescriptor[]` result into the mutable
 * `{name,description}[]` shape that downstream `TurnContextInput.activeSkills`
 * expects (legacy shape pre-readonly).
 *
 * Byte-identical no-op path:
 *   - When `resolvedSkills` is empty, returns the caller's `activeSkills`
 *     reference VERBATIM (same identity, no allocation). The trade-off:
 *     we cannot freeze the result, so callers must continue to treat
 *     `activeSkills` as opaque.
 *   - When plugin skills exist, allocates a single new mutable array.
 *
 * Pure function — extracted from `prepareTurnContext` purely to keep the
 * loop's cognitive complexity inside the biome ceiling.
 */
export const augmentActiveSkillsWithPlugin = (
  callerActiveSkills:
    | { name: string; description: string; rawDependencies?: unknown }[]
    | undefined,
  pluginActivation: ResolvedPluginActivation,
): { name: string; description: string; rawDependencies?: unknown }[] | undefined => {
  if (pluginActivation.resolvedSkills.length === 0) return callerActiveSkills
  const merged = unionActiveSkills(callerActiveSkills, pluginActivation.resolvedSkills)
  // ADR-0476 — preserve each skill's lifted `dependencies` block through the
  // union projection so the per-turn MCP reconcile can still see it (the field
  // rides with its skill; absent for skills with no deps block).
  return merged.map((s) => ({
    name: s.name,
    description: s.description,
    ...(s.rawDependencies !== undefined ? { rawDependencies: s.rawDependencies } : {}),
  }))
}

/**
 * Per-turn plugin activation hook. Called by `prepareTurnContext` AFTER
 * memory recall / compaction but BEFORE `buildTurnContext` so the
 * resulting skills ride the SAME prompt build.
 *
 * @param config             — narrow AgentConfig view; only
 *                             `activatePlugins?` is read.
 * @param latestUserText     — last user-role text content in working memory
 *                             (loop.ts derives this via `latestUserTextFromWm`).
 *                             Absent / empty ⇒ no work.
 * @param turnId             — opaque per-turn id forwarded to the activation
 *                             handler for correlation only. May be undefined.
 * @returns                  — `{ resolvedSkills: readonly ... }`. NEVER throws.
 *                             Absent activator OR empty user text OR zero
 *                             mentions ⇒ canonical-empty `EMPTY` constant.
 */
/**
 * ADR-0360 — best-effort emit. The emitter contract is already NO-THROW
 * (ADR-0352 §types.ts) and the ADR-0358 adapter delegates to a
 * MetricsRegistry that silently coerces poison values, but we wrap
 * every emit in try/catch as defence-in-depth so even a hostile custom
 * emitter cannot break the activation hook.
 *
 * Codex OTel attribute vocabulary mapping (memory
 * `codex-otel-attribute-vocabulary`): the `codex_r2.activation.*` series
 * is the v3 equivalent of Codex's `codex.turn.*` span family — same
 * shape (count + sum_ms), same labels-as-attrs convention.
 */
const safeEmit = (
  emitter: MetricEmitterPort | undefined,
  fn: (e: MetricEmitterPort) => void,
): void => {
  if (emitter === undefined) return
  try {
    fn(emitter)
  } catch {
    // emitter is best-effort — NEVER throw out of this wrapper.
  }
}

/** Monotonic clock seam — `performance.now()` is non-decreasing on
 *  every platform Bun targets so latency math is safe even if the
 *  wall clock jumps. */
const monotonicNow = (): number => performance.now()

/**
 * ADR-0476 — skill→MCP auto-attach reconcile hook.
 *
 * Narrow side-channel the composition root sets on `AgentConfig`:
 * `(cfg as { skillMcpSession?: SkillMcpSession }).skillMcpSession`. ONE
 * coordinator per session (created at session start by the composition root,
 * wired to `@/agent/plugin-mcp-launcher` via the attach/detach ports). When
 * present, {@link reconcileSkillMcpForTurn} reconciles the desired MCP set over
 * the CURRENT active skills every turn so that:
 *   - a skill with an MCP dep going active ⇒ its server is attached ONCE,
 *   - a second skill declaring the SAME server ⇒ attached only once (the
 *     session's dedupe survives across turns),
 *   - a skill going inactive ⇒ its now-orphaned server is detached.
 *
 * DEFAULT-OFF + byte-identical: the coordinator's `resolveMcpDeps` is gate-
 * aware (`QUANTA_SKILL_MCP_DEPS !== "1"` ⇒ empty desired set ⇒ zero attach),
 * AND when `skillMcpSession` is absent this hook is a pure no-op (no
 * allocation, returns immediately).
 */
export interface SkillMcpReconcileConfigLike {
  readonly skillMcpSession?: SkillMcpSession
}

/**
 * Reconcile the session's MCP attach set over the active skills. NO-THROW:
 * the coordinator itself never throws, but we wrap defensively so a hostile
 * custom session can never break a turn. Absent session ⇒ immediate no-op.
 *
 * @param config       — narrow view; only `skillMcpSession?` is read.
 * @param activeSkills — the CURRENT active skill deps (each with its raw
 *                       `dependencies` block, lifted via
 *                       `@/skill/skill-frontmatter` `liftRawDependenciesBlock`).
 * @returns the identities attached/detached this turn (empty when no-op).
 */
export const reconcileSkillMcpForTurn = async (
  config: SkillMcpReconcileConfigLike,
  activeSkills: readonly ActiveSkillDeps[],
): Promise<{ attached: readonly string[]; detached: readonly string[] }> => {
  const session = config.skillMcpSession
  if (session === undefined) return { attached: [], detached: [] }
  try {
    return await session.reconcile(activeSkills)
  } catch {
    // The coordinator is contractually NO-THROW; this is belt-and-suspenders
    // so a non-conforming session injection can never break the turn.
    return { attached: [], detached: [] }
  }
}

/**
 * ADR-0476 — map the loop's active-skill channel (`{name, rawDependencies?}`)
 * onto `ActiveSkillDeps` and reconcile the session's MCP attach set for the
 * turn. Extracted from `prepareTurnContext` so that hot function stays under the
 * cognitive-complexity cap. Pure no-op (immediate return, NO allocation) when no
 * `skillMcpSession` is wired — the common path — so it is byte-identical and
 * zero-cost by default.
 *
 * NO-THROW (HARD contract): the loop `await`s this UNGUARDED, so it MUST NOT
 * throw for ANY input. The `.map()` is inside the try because `activeSkills`
 * MAY carry a hostile element (e.g. a plugin activator returning an object with
 * a throwing `name` getter) — a thrown projection must NOT break the turn. A
 * per-element guard also drops any single malformed entry rather than failing
 * the whole reconcile.
 */
export const reconcileSkillMcpDepsForTurn = async (
  config: SkillMcpReconcileConfigLike,
  activeSkills: readonly { name: string; rawDependencies?: unknown }[] | undefined,
): Promise<void> => {
  if (config.skillMcpSession === undefined) return
  try {
    const deps: ActiveSkillDeps[] = []
    for (const s of activeSkills ?? []) {
      try {
        // A non-string `name` cannot be a skillId — skip it (defensive: the
        // channel is typed but a hostile activator can violate the type).
        if (typeof s?.name !== "string") continue
        deps.push(
          s.rawDependencies !== undefined
            ? { skillId: s.name, rawDependencies: s.rawDependencies }
            : { skillId: s.name },
        )
      } catch {
        // Hostile getter on this entry — drop it, keep the rest.
      }
    }
    await reconcileSkillMcpForTurn(config, deps)
  } catch {
    // Belt-and-suspenders: nothing above should throw (the inner reconcile is
    // itself NO-THROW), but a hostile `activeSkills` iterator must never break
    // the turn. Swallow → the turn proceeds with no reconcile this round.
  }
}

export const resolvePluginActivationForTurn = async (
  config: ActivationHookConfigLike,
  latestUserText: string | undefined,
  turnId: string | undefined,
): Promise<ResolvedPluginActivation> => {
  if (config.activatePlugins === undefined) return EMPTY
  if (latestUserText === undefined || latestUserText.length === 0) return EMPTY
  let mentions: readonly ParsedMention[]
  try {
    // Lazy import keeps this slice's static import graph minimal — the
    // mention-injection module is only loaded when an activation handler
    // is actually wired. parseMentions itself is pure + sync, but the
    // dynamic import bounds the slice fence even tighter.
    const mod = await import("@/agent/mention-injection")
    mentions = mod.parseMentions(latestUserText)
  } catch {
    return EMPTY
  }
  if (mentions.length === 0) return EMPTY
  const emitter = config.metricsEmitter
  const startedAt = monotonicNow()
  // ADR-0360 — counter: total activation invocations (post-mentions, pre-
  // activator). Emitted up-front so a thrown activator still bumps the
  // call counter — operators can compute error_rate = errors / calls.
  safeEmit(emitter, (e) => e.counter("codex_r2.activation.calls", 1))
  try {
    const opts = turnId !== undefined ? { turnId } : undefined
    const agg = await config.activatePlugins(mentions, opts)
    // Defensive narrow: an activation closure SHOULD return
    // `{ handles, resolvedSkills }` but a non-conforming impl must not
    // poison the loop. Treat anything non-array as empty.
    const resolved = Array.isArray(agg?.resolvedSkills) ? agg.resolvedSkills : []
    const elapsedMs = monotonicNow() - startedAt
    safeEmit(emitter, (e) => {
      // Counter approach (ADR-0360 Option B): sum_ms as a monotonic
      // counter + calls counter ⇒ mean latency = sum_ms / calls.
      // Avoids extending MetricEmitterPort with `histogram` (ADR-0352
      // shape stays 2-method).
      e.counter("codex_r2.activation.sum_latency_ms", Math.max(0, elapsedMs))
      // Per-call resolved-skills count — useful for sizing the active-
      // skills channel under different plugin populations.
      e.counter("codex_r2.activation.resolved_skills_count", resolved.length)
    })
    return { resolvedSkills: resolved }
  } catch {
    safeEmit(emitter, (e) => e.counter("codex_r2.activation.errors", 1))
    return EMPTY
  }
}
