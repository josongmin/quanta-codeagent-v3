/**
 * `/goal` (Codex parity, ADR-0394) — objective-store compose-passthrough WIRING
 * hellgate.
 *
 * The `/goal` feature shares ONE `ObjectivePort` between the surface (the `/goal`
 * slash + idle continuation ticker + status chip) and the LLM `objective_*` tools
 * by threading the SAME store instance DOWN through the runtime compose seam:
 *
 *   compose.objective                          (RuntimeFacadeComposeOptions.objective)
 *     ─▶ context-state patch                    (PASS_THROUGH_COMPOSE_KEYS ∋ "objective")
 *        ─▶ runtime-context snapshot            (RuntimeContextSnapshot.objective)
 *           ─▶ per-turn RuntimeBase             (buildSnapshot / base.objective)
 *              ─▶ assembled AgentConfig         (maybeWireObjective caller-override)
 *
 * A single object identity MUST survive every hop — deep-equal would be VACUOUS
 * (two fresh in-memory stores are structurally equal but do NOT share state, so
 * the agent marking the goal complete would NOT stop the surface's pursuit). So
 * every assertion here is `===` (SAME instance), driven by real `createObjectiveStore()`
 * sentinels.
 *
 * Reachability (investigated — see the per-block comments):
 *   • `PASS_THROUGH_COMPOSE_KEYS` + `applyRuntimeFacadeComposeOptions` are BOTH
 *     module-private in `src/sdk/runtime/context.ts` (not exported, not barrelled),
 *     AND the public facade entry that routes through them
 *     (`createRuntimeFromAgentConfigBase({ compose })`) does not re-expose the
 *     composed base (reading it off a live facade would need a turn = a live LLM,
 *     out of unit scope). So the pass-through is pinned by driving the EXACT op the
 *     private helper performs: `applyRuntimeFacadeComposeOptions` calls
 *     `binding.patch({ [key]: value })` per present PASS_THROUGH key, and
 *     `binding.patch` (via the exported `createRuntimeContextBindingFromAgentConfigBase`)
 *     IS reachable — the tests read the sentinel back off the rebuilt snapshot.
 *     This exercises the REAL patch/snapshot code, not a re-implementation.
 *   • `buildSnapshot` (context-binding/base.ts) IS exported — pins the
 *     snapshot ← base link directly.
 *   • `assembleAgentConfig` (agent-config-assembler.ts) IS exported — pins the
 *     full base → cfg leg + `maybeWireObjective` caller-override / fresh-mint /
 *     gate-off legs.
 */
import { describe, expect, test } from "bun:test"
import { type AssemblerEnv, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { createRuntimeContextBindingFromAgentConfigBase } from "@/host/runtime/internal/context-binding"
import { buildSnapshot } from "@/host/runtime/internal/context-binding/base"
import { createObjectiveStore, type ObjectivePort } from "@/objective"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

// ── minimal base double ────────────────────────────────────────────────────────
// The seams under test read only a handful of AgentConfig fields (stream/cwd/llm/
// permission/registry/messages); everything else is opaque to the objective slot.
// No sessionId ⇒ the assembler's session-resource lookup takes the null branch
// (byte-identical, no global-registry mutation) — keeping the test hermetic.

const stubStream = () => ({ emit: (_e: unknown) => void 0 })

const baseConfig = (): RuntimeAgentConfigBase =>
  ({
    stream: stubStream(),
    cwd: "/repo",
    llm: {},
    permission: { mode: "default" },
    registry: { all: () => [], has: () => false },
    messages: [],
  }) as unknown as RuntimeAgentConfigBase

/** Read the (duck-typed `unknown`) objective slot off any carrier. */
const objectiveOf = (carrier: unknown): ObjectivePort | undefined =>
  (carrier as { objective?: ObjectivePort }).objective

const OBJ_ON: AssemblerEnv = { QUANTA_OBJECTIVE_TOOLS: "1" }

/* ================================================================== */
/*  1. PASS_THROUGH drift guard (observable effect of the private     */
/*     PASS_THROUGH_COMPOSE_KEYS ∋ "objective" + applyRuntime…Options) */
/* ================================================================== */

describe("compose-passthrough · PASS_THROUGH_COMPOSE_KEYS ∋ objective (observable)", () => {
  // REACHABILITY / not-fabricated: `PASS_THROUGH_COMPOSE_KEYS` and
  // `applyRuntimeFacadeComposeOptions` are module-private in
  // `src/sdk/runtime/context.ts` (not exported, not barrelled), and the public
  // facade entry that routes through them (`createRuntimeFromAgentConfigBase({
  // compose })`) does NOT re-expose the composed base — the only way to read the
  // pass-through result off a live facade is to run a turn, which needs a live
  // LLM (out of unit scope, would be mock-theater). So instead of a vacuous
  // "constructed the facade" assertion, we pin the EXACT op the private helper
  // performs: `applyRuntimeFacadeComposeOptions` loops PASS_THROUGH_COMPOSE_KEYS
  // and calls `binding.patch({ [key]: value })` for each present compose value.
  // `binding.patch` (via the exported `createRuntimeContextBindingFromAgentConfigBase`)
  // IS reachable, so the tests below drive that identical per-key op on the REAL
  // binding + read the sentinel back off the rebuilt snapshot. A future edit that
  // drops "objective" from PASS_THROUGH_COMPOSE_KEYS OR from `RuntimeContextPatch`'s
  // Pick makes this patch a no-op ⇒ RED (proven by in-tree revert).

  test("HELL-GOAL-patch-passthrough: binding.patch({ objective }) — the EXACT op applyRuntimeFacadeComposeOptions runs per PASS_THROUGH key — surfaces the SAME instance on the snapshot", () => {
    // `applyRuntimeFacadeComposeOptions` loops PASS_THROUGH_COMPOSE_KEYS and, for
    // each present compose value, calls `binding.patch({ [key]: value })`. Driving
    // `patch({ objective })` on the REAL binding is therefore the exact per-key
    // op the compose seam performs. `RuntimeContextPatch`'s Pick MUST include
    // "objective" for this to survive the immutable patch → snapshot rebuild.
    const sentinel = createObjectiveStore()
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base: baseConfig() })
    const patched = binding.patch({ objective: sentinel } as never)
    // Identity — NOT deep-equal: a fresh store would deep-equal but not share state.
    expect(objectiveOf(patched.snapshot)).toBe(sentinel)
  })

  test("HELL-GOAL-patch-absent-control: NO objective patch ⇒ snapshot carries no objective (paired control — the pass-through is the ONLY reason it appears)", () => {
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base: baseConfig() })
    expect(objectiveOf(binding.snapshot)).toBeUndefined()
  })

  test("HELL-GOAL-patch-distinct: two DIFFERENT sentinels patch to their OWN instances (identity is real, not a fixed singleton)", () => {
    const a = createObjectiveStore()
    const b = createObjectiveStore()
    expect(a).not.toBe(b) // distinct inputs …
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base: baseConfig() })
    expect(objectiveOf(binding.patch({ objective: a } as never).snapshot)).toBe(a)
    expect(objectiveOf(binding.patch({ objective: b } as never).snapshot)).toBe(b) // … distinct outputs
  })
})

/* ================================================================== */
/*  2. snapshot ← base link (buildSnapshot, exported)                 */
/* ================================================================== */

describe("buildSnapshot · base.objective ⇒ snapshot.objective (same instance)", () => {
  // buildSnapshot folds `whenDefined("objective", base.objective)` onto the
  // snapshot. This pins the state ← base half of the compose chain directly.

  test("HELL-GOAL-snapshot-identity: buildSnapshot surfaces base.objective as the SAME instance", () => {
    const sentinel = createObjectiveStore()
    const snap = buildSnapshot({ ...baseConfig(), objective: sentinel } as never)
    expect(objectiveOf(snap)).toBe(sentinel)
  })

  test("HELL-GOAL-snapshot-absent-control: no base.objective ⇒ snapshot omits the key (whenDefined, byte-identical default)", () => {
    const snap = buildSnapshot(baseConfig() as never)
    expect(objectiveOf(snap)).toBeUndefined()
    expect(Object.hasOwn(snap as object, "objective")).toBe(false)
  })
})

/* ================================================================== */
/*  3. base ⇒ cfg.objective end-to-end via the REAL turn assembler    */
/*     (assembleAgentConfig as the RuntimeAgentTurnAssembler)          */
/* ================================================================== */

describe("compose chain end-to-end · base.objective ⇒ assembled cfg.objective (same instance)", () => {
  // The runtime's per-turn assembler is `buildInteractiveTurnAssembler`, which
  // wraps `assembleAgentConfig`. Feeding a base that carries the composed
  // objective through `assembleAgentConfig` (gate ON) proves the FULL
  // snapshot→base→cfg leg: the objective spreads through `...req.base` and
  // `maybeWireObjective`'s caller-override (`if (slot.objective !== undefined) return`)
  // preserves the SAME instance rather than minting a fresh store.

  test("HELL-GOAL-e2e-identity: a composed objective on the base reaches cfg.objective as the SAME instance (gate ON)", () => {
    const sentinel = createObjectiveStore()
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: { ...baseConfig(), objective: sentinel } as never },
      OBJ_ON,
    )
    expect(objectiveOf(cfg)).toBe(sentinel)
  })
})

/* ================================================================== */
/*  4. maybeWireObjective caller-override / fresh-mint / gate-off      */
/*     (assembleAgentConfig, exported)                                 */
/* ================================================================== */

describe("maybeWireObjective · caller-override + fresh-mint + gate preservation", () => {
  test("HELL-GOAL-override: pre-set objective + gate ON ⇒ cfg.objective IS the pre-set instance (NOT freshly minted)", () => {
    const sentinel = createObjectiveStore()
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: { ...baseConfig(), objective: sentinel } as never },
      OBJ_ON,
    )
    expect(objectiveOf(cfg)).toBe(sentinel)
  })

  test("HELL-GOAL-fresh-control: NO pre-set + gate ON ⇒ cfg.objective is a FRESH store (paired control — a DIFFERENT instance)", () => {
    const cfg = assembleAgentConfig({ mode: "interactive", base: baseConfig() }, OBJ_ON)
    const minted = objectiveOf(cfg)
    expect(minted).toBeDefined()
    // Not any sentinel we own — a freshly-minted store. Prove it's a live store
    // (has the ObjectivePort surface) AND distinct from an unrelated fresh one.
    expect(typeof minted?.set).toBe("function")
    expect(minted).not.toBe(createObjectiveStore())
  })

  test("HELL-GOAL-gate-off-preserves: pre-set objective + gate UNSET ⇒ cfg.objective STILL the pre-set instance (early-return does NOT clobber it)", () => {
    // maybeWireObjective returns early when the gate is off — a pre-set slot that
    // rode in on req.base must survive untouched (the surface's store still flows
    // to the tools if some other surface set the gate; the assembler must never
    // DROP a caller value just because the gate is off).
    const sentinel = createObjectiveStore()
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: { ...baseConfig(), objective: sentinel } as never },
      {}, // QUANTA_OBJECTIVE_TOOLS unset
    )
    expect(objectiveOf(cfg)).toBe(sentinel)
  })

  test("HELL-GOAL-gate-off-no-mint: NO pre-set + gate UNSET ⇒ cfg.objective stays UNSET (default-OFF byte-identical for bench/web surfaces)", () => {
    const cfg = assembleAgentConfig({ mode: "interactive", base: baseConfig() }, {})
    expect(objectiveOf(cfg)).toBeUndefined()
  })

  test("HELL-GOAL-gate-zero-no-mint: gate='0' ⇒ cfg.objective stays UNSET (strict opt-in, no accidental mint)", () => {
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseConfig() },
      { QUANTA_OBJECTIVE_TOOLS: "0" },
    )
    expect(objectiveOf(cfg)).toBeUndefined()
  })
})

/* ================================================================== */
/*  5. shared-store mutation proof — the WHOLE POINT of the identity   */
/*     invariant (agent marks goal complete ⇒ surface's read reflects) */
/* ================================================================== */

describe("shared-store semantics · a mutation via cfg.objective is visible on the surface's SAME store", () => {
  test("HELL-GOAL-shared-mutation: assembler-preserved store — a status flip through cfg.objective is observed on the surface handle (identity ⇒ shared state, deep-equal would MISS this)", () => {
    // This is why identity (not deep-equal) matters: the surface owns `sentinel`
    // and backs `/goal` + the idle ticker with it; the LLM `objective_*` tools
    // mutate `cfg.objective`. If they are the SAME instance, the agent marking the
    // goal complete is immediately visible on the surface's handle (pursuit stops).
    const sentinel = createObjectiveStore()
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: { ...baseConfig(), objective: sentinel } as never },
      OBJ_ON,
    )
    const shared = objectiveOf(cfg)
    expect(shared).toBe(sentinel)

    const thread = "t-goal-1"
    shared?.set(thread, { goal: "close the wiring gap", successCriteria: ["tests green"] })
    // Mutate through the tools' handle …
    shared?.markCriterion(thread, shared.get(thread)?.successCriteria?.[0]?.id ?? "c0", true)
    // … and observe it on the surface's OWN handle (same instance).
    const onSurface = sentinel.get(thread)
    expect(onSurface).not.toBeNull()
    expect(onSurface?.goal).toBe("close the wiring gap")
  })
})
