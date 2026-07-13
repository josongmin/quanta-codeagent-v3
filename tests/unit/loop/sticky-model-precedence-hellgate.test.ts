import { describe, expect, test } from "bun:test"
import { resolveSkillTurnOverride } from "@/agent/loop/skill-gate"
import type { LLMPort } from "@/llm"
import type { AgentConfig } from "@/agent/types"

/**
 * sticky-model-loop-consume (L3) leaf-unit hellgate.
 *
 * The STREAM-side precedence that decides WHICH `LLMPort` actually processes a
 * turn lives in `resolveSkillTurnOverride` (the loop's stream-consume calls it
 * per turn: `resolveSkillTurnOverride(config, skillGate?.activeOverride(),
 * stickyModelId)`). Precedence — highest first:
 *
 *   1. SKILL `model:` override  (`override.model`)
 *   2. per-mode STICKY model    (`stickyModelId`)
 *   3. base `config.llm`        (no swap)
 *
 * The sibling `active-model-threshold-hellgate.test.ts` pins the ID string used
 * for the COMPACTION window (`resolveActiveModelId`). This file pins the port
 * SWAP that streams — the effect the ID mirror is derived from. We observe the
 * real effect by identity: which distinct `LLMPort` instance comes back as
 * `.llm`, not just a model string.
 *
 * Every candidate port is a DISTINCT instance so a returned port is
 * unambiguously attributable (paired-control: skill-present vs skill-absent
 * with everything else held fixed must select different ports).
 *
 * Red-on-injection (proved in-tree, then reverted): flip the precedence in
 * `skill-gate.ts` so sticky beats the skill override — the skill-wins case goes
 * RED. See the report for the exact edit.
 */

/** Distinct, identity-tagged LLM double. `stream` is never invoked here (we test
 *  SELECTION, not streaming), but present so the shape is a real `LLMPort`. */
const mkPort = (model: string): LLMPort => ({
  model,
  // biome-ignore lint/correctness/useYield: selection-only double, never streamed.
  async *stream() {
    throw new Error(`unexpected stream() on ${model}`)
  },
})

const BASE = mkPort("base-model")
const STICKY = mkPort("sticky-model")
const SKILL = mkPort("skill-model")

/** Minimal config: only the fields `resolveSkillTurnOverride` reads
 *  (`llm`, `modelCandidates`, and — absent here — `sessionEffort`). */
const cfg = (candidates: readonly LLMPort[]): AgentConfig =>
  ({
    llm: BASE,
    modelCandidates: candidates.map((p) => ({ id: p.model as string, port: p })),
  }) as unknown as AgentConfig

// All three candidate ports are always wired so a MISS is a genuine precedence
// choice, never an accidental "candidate not registered" fallthrough.
const ALL = cfg([STICKY, SKILL])

describe("resolveSkillTurnOverride — stream-side model precedence (sticky-model-loop-consume L3)", () => {
  test("skill override present ⇒ SKILL wins (sticky ignored even when set)", () => {
    // paired-control arm A: skill override + sticky BOTH set.
    const resolved = resolveSkillTurnOverride(ALL, { model: "skill-model" }, "sticky-model")
    // real effect: the SKILL port instance is what will stream.
    expect(resolved.llm).toBe(SKILL)
    expect(resolved.llm.model).toBe("skill-model")
    // and it is NOT the sticky/base — the loser ports are excluded.
    expect(resolved.llm).not.toBe(STICKY)
    expect(resolved.llm).not.toBe(BASE)
  })

  test("PAIRED CONTROL: dropping the skill override (sticky held fixed) flips the winner to STICKY", () => {
    // arm B: identical to arm A EXCEPT override absent — the ONLY changed input.
    const withSkill = resolveSkillTurnOverride(ALL, { model: "skill-model" }, "sticky-model")
    const noSkill = resolveSkillTurnOverride(ALL, undefined, "sticky-model")
    expect(withSkill.llm).toBe(SKILL)
    expect(noSkill.llm).toBe(STICKY)
    // the single input difference (override) drove a DIFFERENT port — precedence
    // is genuinely load-bearing, not a constant.
    expect(withSkill.llm).not.toBe(noSkill.llm)
  })

  test("skill absent + sticky present ⇒ STICKY wins over base", () => {
    const resolved = resolveSkillTurnOverride(ALL, undefined, "sticky-model")
    expect(resolved.llm).toBe(STICKY)
    expect(resolved.llm.model).toBe("sticky-model")
    expect(resolved.llm).not.toBe(BASE)
  })

  test("skill absent + sticky absent ⇒ base fallthrough (byte-identical default-OFF)", () => {
    // No override, no sticky id: the loop streams from the UNSWAPPED base port —
    // exactly the pre-sticky legacy path.
    const resolved = resolveSkillTurnOverride(ALL, undefined, undefined)
    expect(resolved.llm).toBe(BASE)
    expect(resolved.explicitOff).toBe(false)
  })

  test("unknown sticky id (no matching candidate) ⇒ base fallthrough, no crash", () => {
    // Advisory degrade: a sticky preference naming a port that is not wired must
    // NOT throw and must NOT partial-swap — it silently keeps the base.
    const resolved = resolveSkillTurnOverride(ALL, undefined, "ghost-model")
    expect(resolved.llm).toBe(BASE)
  })

  test("unknown skill override id (no matching candidate) ⇒ base fallthrough, no crash", () => {
    // Same degrade for a skill demanding an unregistered model. Note: the skill
    // override still SUPPRESSES the sticky fallback (override branch is taken),
    // so we land on base — NOT on the otherwise-valid sticky candidate.
    const resolved = resolveSkillTurnOverride(ALL, { model: "ghost-model" }, "sticky-model")
    expect(resolved.llm).toBe(BASE)
    expect(resolved.llm).not.toBe(STICKY)
  })

  test("no candidates wired at all ⇒ base fallthrough for every arm (store-absent anchor)", () => {
    const bare = cfg([])
    expect(resolveSkillTurnOverride(bare, undefined, undefined).llm).toBe(BASE)
    expect(resolveSkillTurnOverride(bare, undefined, "sticky-model").llm).toBe(BASE)
    expect(resolveSkillTurnOverride(bare, { model: "skill-model" }, undefined).llm).toBe(BASE)
  })
})
