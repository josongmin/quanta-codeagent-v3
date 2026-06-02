/**
 * `wireInteractiveKnobs` — composition-root fold for the three INTERACTIVE
 * knobs that the live CLI / unified-agent surfaces must apply directly.
 *
 * THE GAP THIS CLOSES (jun-02 adversarial review): `advisor`, `task-budget`,
 * and `compose-authoring` are registered in the `@/runner/knobs` framework,
 * but `applyKnobs` (the only thing that folds a resolved knob value onto an
 * `AgentConfig`) is called ONLY by the bench driver (`knobs-bench.ts`, surface
 * `"bench"`). The live CLI (`apps/cli`) and unified-agent (`apps/agent`) NEVER
 * call `applyKnobs`, so `QUANTA_ADVISOR_MODEL` / `QUANTA_TASK_BUDGET` /
 * `QUANTA_COMPOSE_AUTHORING` activated NOTHING for users. (These three knobs
 * also EXCLUDE the `bench` surface deliberately, so they were dead on every
 * surface that actually applies them.)
 *
 * THE FIX mirrors the codebase's REAL interactive-wiring pattern — a DIRECT
 * env read at the composition root (cf. `resolveMemoryConfigFromEnv`) — but
 * REUSES each knob's existing `parse` + `apply` so the env→config semantics are
 * byte-identical to the matrix (same allowlist, same integer gate, same strict
 * `"1"` literal). This is the SINGLE place the live surfaces fold these three.
 *
 * Default-OFF / byte-identical: when none of the three env vars resolve, this
 * returns the input `cfg` UNCHANGED (`===`). Each knob's `apply` already
 * surface-guards (`SURFACES.includes(ctx.surface)`), and we only pass live
 * interactive surfaces here, so an off-surface caller is a defensive no-op too.
 *
 * NOT the knob framework: this does NOT touch `applyKnobs` / `resolveKnobs` /
 * the registry resolution layers (CLI-flag / session-override / config-file /
 * preset). Those layers stay bench-only by design. This helper activates ONLY
 * the env-var layer for exactly these three interactive knobs.
 *
 * Importing the three knob modules fires their module-level `registerKnob`
 * side effect, but the module body runs ONCE per process (Bun module cache),
 * so this never collides with `apps/cli/knobs-bootstrap.ts` (which imports the
 * same modules) — both reference the single cached registration.
 */

import type { AgentConfig } from "@/agent"
import type { AnyKnob, ApplyContext, Surface } from "@/runner/knobs"
import { advisorKnob } from "@/runner/knobs/knobs/advisor"
import { composeAuthoringKnob } from "@/runner/knobs/knobs/compose-authoring"
import { taskBudgetKnob } from "@/runner/knobs/knobs/task-budget"

type EnvLike = Readonly<Record<string, string | undefined>>

/** The three interactive knobs the live surfaces fold directly. Each is
 *  applied via its OWN `parse` + `apply` so the matrix semantics are reused
 *  verbatim. Order is irrelevant (they touch disjoint `AgentConfig` slots).
 *
 *  Widened to `AnyKnob` so the heterogeneous value types (AdvisorValue / `true`
 *  / TaskBudget) do NOT collapse to an unusable intersection in the fold loop —
 *  the framework's own `asAnyKnob` widening (used by the registry) is the same
 *  posture. `parse`'s output flows straight into `apply` per knob, so the
 *  per-knob value/apply pairing is preserved at runtime. */
const INTERACTIVE_KNOBS: readonly AnyKnob[] = [
  advisorKnob as AnyKnob,
  composeAuthoringKnob as AnyKnob,
  taskBudgetKnob as AnyKnob,
]

/** The minimum the three knobs' `apply` read off the config: `advisor` and
 *  `compose-authoring` close over `cfg.llm`; `task-budget` only sets a field.
 *  Generic over the concrete base shape (the agent surface passes a
 *  `RuntimeAgentConfigBase`, the CLI passes a full `AgentConfig`) so the fold
 *  preserves the caller's type, mirroring `wireOptionalAgentPorts`. */
type InteractiveKnobBase = Pick<AgentConfig, "llm"> & Partial<AgentConfig>

/**
 * Fold the env-resolved values of the three interactive knobs onto `cfg`.
 *
 * @param cfg     baseline config (carries `llm`, which `advisor` /
 *                `compose-authoring` close over to build their consult /
 *                authoring mechanisms).
 * @param env     the surface's already-loaded env view (this slice never reads
 *                `process.env` itself — the surface owns the read).
 * @param surface the live interactive surface (`cli` | `agent-batch` |
 *                `agent-interactive`). `bench` is intentionally excluded by the
 *                knobs themselves.
 *
 * Byte-identical when no knob resolves: returns the same `cfg` reference.
 */
export const wireInteractiveKnobs = <T extends InteractiveKnobBase>(
  cfg: T,
  env: EnvLike,
  surface: Surface,
): T => {
  const ctx: ApplyContext = { surface }
  let next = cfg
  for (const knob of INTERACTIVE_KNOBS) {
    const value = knob.parse(env[knob.envKey])
    if (value === undefined) continue
    // Each knob's `apply` is PURE + surface-guarded; reuse it verbatim so the
    // live fold is identical to the matrix fold. The `apply` signature is keyed
    // to `AgentConfig`; the cast bridges the generic base (which has every slot
    // these knobs touch) the same way `wireOptionalAgentPorts` does. `value`
    // came from THIS knob's own `parse`, so the runtime value/apply pairing is
    // exact (the `AnyKnob` widening only erases it at the type level).
    next = knob.apply(next as AgentConfig, value, ctx) as unknown as T
  }
  return next
}
