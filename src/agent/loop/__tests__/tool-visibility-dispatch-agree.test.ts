/**
 * FIX 3 (HELLGATE) — visible-tool set and dispatch scope must AGREE.
 *
 * The dispatch deny in `stream-callbacks.ts#handleSkillScope` fires whenever an
 * armed `skillGate` has `!allow(name)` — INDEPENDENT of `skillScopeV2`. The
 * send-time visible-spec filter previously ran ONLY when `skillScopeV2` was ON,
 * so with the flag OFF the model SAW tools it would then be hard-denied
 * (see-but-can't-call). The unification: `streamConsume` now filters the visible
 * specs via `filterSpecsByScope` in BOTH flag states, sharing the same
 * `skillGate.allow` predicate the dispatch gate uses.
 *
 * This test pins the agreement invariant at the shared predicate seam
 * (`filterSpecsByScope` for visibility, `gate.allow` for dispatch) — the exact
 * two consumers the fix aligned — for the flag-OFF armed-skill case, plus the
 * byte-identical no-skill-armed case.
 *
 * SEAM-LEVEL guarantee (do NOT rely on this file alone): the actual reverted
 * `streamConsume` line — `visibleSpecs = filterSpecsByScope(specs, skillGate)`
 * (previously gated on `runtimeConfig().skillScopeV2`) — is pinned red-on-revert
 * by `tests/integration/skill-scope-e2e.test.ts` ("L1 availability filter"),
 * which drives the real `runAgent → streamConsume` with the flag default-OFF and
 * asserts the armed turn's `onTurnStreamInput.tools` is narrowed. This file is
 * the fast unit pin on the shared predicate; that e2e is the wiring proof.
 */

import { describe, expect, test } from "bun:test"
import { buildSkillGate, filterSpecsByScope } from "../skill-gate"

type Spec = { name: string }
const specsOf = (...names: string[]): Spec[] => names.map((name) => ({ name }))

const armedGate = (skill: string, allow: string[]) => {
  const gate = buildSkillGate(new Map([[skill, allow]]), undefined)
  if (gate === undefined) throw new Error("expected a gate")
  gate.observe("Skill", { name: skill }, true)
  return gate
}

/** The visible set the model receives (mirrors `streamConsume`'s
 *  `visibleSpecs = filterSpecsByScope(specs, skillGate)` — UNCONDITIONAL on the
 *  flag after FIX 3). The dispatch gate short-circuits when `!gate.allow(name)`. */
const visibleNames = (gate: ReturnType<typeof buildSkillGate>, specs: Spec[]): Set<string> =>
  new Set(filterSpecsByScope(specs, gate).map((s) => s.name))
const dispatchAllows = (gate: NonNullable<ReturnType<typeof buildSkillGate>>, name: string) =>
  gate.allow(name)

describe("tool visibility vs dispatch scope agree (FIX 3)", () => {
  test("armed skill (flag-OFF path): no tool is visible-but-denied or hidden-but-allowed", () => {
    const specs = specsOf("read", "edit", "bash", "grep", "write")
    // allowlist declares `edit` only; nav-base (read/grep) always in scope,
    // so bash/write are the out-of-scope set the dispatch gate denies.
    const gate = armedGate("localize-fault", ["edit"])
    const visible = visibleNames(gate, specs)

    for (const { name } of specs) {
      // The core invariant: a tool is VISIBLE iff dispatch ALLOWS it.
      expect(visible.has(name)).toBe(dispatchAllows(gate, name))
    }
    // Concretely: bash/write are BOTH hidden AND denied (no see-but-can't-call).
    expect(visible.has("bash")).toBe(false)
    expect(dispatchAllows(gate, "bash")).toBe(false)
    expect(visible.has("write")).toBe(false)
    // edit + nav-base are BOTH visible AND allowed.
    expect(visible.has("edit")).toBe(true)
    expect(dispatchAllows(gate, "edit")).toBe(true)
    expect(visible.has("read")).toBe(true)
  })

  test("no skill armed ⇒ filter returns the SAME specs reference (byte-identical)", () => {
    const specs = specsOf("read", "edit", "bash")
    // gate present but no skill observed ⇒ `allow` is true for everything.
    const gate = buildSkillGate(new Map([["s", ["edit"]]]), undefined)
    if (gate === undefined) throw new Error("expected a gate")
    expect(filterSpecsByScope(specs, gate)).toBe(specs) // reference identity
    for (const { name } of specs) expect(dispatchAllows(gate, name)).toBe(true)
  })

  test("no gate at all ⇒ SAME specs reference (byte-identical, v2 OFF / skill-less)", () => {
    const specs = specsOf("read", "edit", "bash")
    expect(filterSpecsByScope(specs, undefined)).toBe(specs)
  })

  test("documents the pre-fix contradiction: OLD flag-OFF visibility disagreed with dispatch", () => {
    const specs = specsOf("read", "edit", "bash")
    const gate = armedGate("localize-fault", ["edit"])
    // PRE-FIX stream-consume: `skillScopeV2 ? filterSpecsByScope(...) : specs`.
    // With the flag OFF the visible set was the UNFILTERED `specs`.
    const preFixVisibleFlagOff = new Set(specs.map((s) => s.name))
    // `bash` was VISIBLE (unfiltered) yet the dispatch gate DENIES it ⇒
    // see-but-can't-call. This asserts the bug existed.
    expect(preFixVisibleFlagOff.has("bash")).toBe(true)
    expect(dispatchAllows(gate, "bash")).toBe(false)

    // POST-FIX stream-consume: `filterSpecsByScope(specs, skillGate)` UNCONDITIONALLY.
    // Now visible == dispatchable — the contradiction is gone.
    const postFixVisible = visibleNames(gate, specs)
    for (const { name } of specs) expect(postFixVisible.has(name)).toBe(dispatchAllows(gate, name))
    expect(postFixVisible.has("bash")).toBe(false)
  })

  test("sealed skill (allowed-tools:[]) ⇒ nav-base still visible AND dispatchable", () => {
    const specs = specsOf("file_tree_summary", "glob", "read", "grep", "bash", "edit")
    const gate = armedGate("read-only-brief", [])
    const visible = visibleNames(gate, specs)
    for (const { name } of specs) expect(visible.has(name)).toBe(dispatchAllows(gate, name))
    expect(visible.has("read")).toBe(true) // nav-base
    expect(visible.has("bash")).toBe(false) // sealed out
    expect(dispatchAllows(gate, "bash")).toBe(false)
  })
})
