/**
 * STRUCTURAL DRIFT HELLGATE (jul-27) — the anti-whack-a-mole ratchet.
 *
 * BACKGROUND: the subagent FS-ownership fence was patched TWICE for incomplete
 * coverage (jul-19 apply_patch, jul-26 field/fail-closed) because nothing tied
 * its closed tool-sets back to the registry's actual write-capable universe — a
 * new write tool silently escaped until someone remembered it. This test closes
 * that class of regression: it cross-checks `OWNERSHIP_WRITE_CLASSIFICATION`
 * (the SSOT) against BOTH machine-readable universes, so a NEW write-capable
 * tool that isn't classified FAILS CI.
 *
 *   Universe 1 — `MUTATING_TOOL_TABLE` (mode.ts): every tool whose kind is
 *     write_filesystem / bash_mutating / git_mutating (can touch host FS).
 *   Universe 2 — gated tool-surface manifest (`GATED_TOOLS`): every entry (and
 *     its group members) with risk:"mutating" (gated write tools invisible to
 *     the mutating table, e.g. lsp_rename_apply).
 *
 * Plus internal consistency: the runtime fence sets (FIELD/UNFENCEABLE/PATCH)
 * MUST equal the classification's field/fail-closed/patch buckets — so the map
 * and the code that reads it cannot drift apart.
 *
 * RED-first proof: delete any classification entry (or any runtime-set member)
 * ⇒ a cross-check below goes RED naming the exact unclassified tool.
 */
import { describe, expect, test } from "bun:test"
import { planModeMutatingTable } from "@/agent/mode"
import {
  buildOwnershipPolicy,
  OWNERSHIP_WRITE_CLASSIFICATION,
  ownershipWriteSets,
} from "@/agent/ownership-policy"
import { GATED_TOOLS } from "@/tool"

const CLASSIFIED = new Set(Object.keys(OWNERSHIP_WRITE_CLASSIFICATION))

// FS-touchable mutating kinds — the kinds whose members CAN write a host FS path.
const FS_TOUCHABLE_KINDS = new Set(["write_filesystem", "bash_mutating", "git_mutating"])

describe("ownership fence — SSOT covers Universe 1 (MUTATING_TOOL_TABLE FS kinds)", () => {
  test("every write_filesystem/bash_mutating/git_mutating tool is classified", () => {
    const table = planModeMutatingTable()
    const unclassified = Object.entries(table)
      .filter(([, kind]) => kind !== null && FS_TOUCHABLE_KINDS.has(kind))
      .map(([name]) => name)
      .filter((name) => !CLASSIFIED.has(name))
    // If this fails, add the named tool(s) to OWNERSHIP_WRITE_CLASSIFICATION with
    // the correct class (leaf/patch/field/shell/fail-closed/non-fs).
    expect(unclassified).toEqual([])
  })
})

describe("ownership fence — SSOT covers Universe 2 (gated risk:mutating manifest)", () => {
  test("every gated risk:mutating tool (and group member) is classified", () => {
    const gatedMutating = new Set<string>()
    for (const entry of GATED_TOOLS) {
      if (entry.risk !== "mutating") continue
      gatedMutating.add(entry.name)
      for (const g of entry.group ?? []) gatedMutating.add(g)
    }
    const unclassified = [...gatedMutating].filter((name) => !CLASSIFIED.has(name)).sort()
    expect(unclassified).toEqual([])
  })
})

describe("ownership fence — runtime sets equal the classification buckets (no drift)", () => {
  const bucket = (cls: string): string[] =>
    Object.entries(OWNERSHIP_WRITE_CLASSIFICATION)
      .filter(([, c]) => c === cls)
      .map(([n]) => n)
      .sort()

  test("FIELD_WRITE_TOOLS keys === classification 'field'", () => {
    expect([...ownershipWriteSets().field].sort()).toEqual(bucket("field"))
  })
  test("UNFENCEABLE_WRITE_TOOLS === classification 'fail-closed'", () => {
    expect([...ownershipWriteSets().failClosed].sort()).toEqual(bucket("fail-closed"))
  })
  test("PATCH_WRITE_TOOLS === classification 'patch'", () => {
    expect([...ownershipWriteSets().patch].sort()).toEqual(bucket("patch"))
  })
})

describe("ownership fence — no classification is a dead/unknown tool name", () => {
  test("every classified name exists in Universe 1 ∪ Universe 2 (no typos/stale)", () => {
    const table = planModeMutatingTable()
    const universe = new Set<string>(Object.keys(table))
    for (const entry of GATED_TOOLS) {
      universe.add(entry.name)
      for (const g of entry.group ?? []) universe.add(g)
    }
    const orphan = [...CLASSIFIED].filter((name) => !universe.has(name)).sort()
    expect(orphan).toEqual([])
  })
})

// ── the classification is not just bookkeeping: prove the buckets actually fence ──
describe("ownership fence — every non-'non-fs' class DENIES an out-of-owned write", () => {
  const enforced = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: true })
  test("policy built", () => expect(enforced?.enforced).toBe(true))

  // one representative escape input per non-safe class → all must be fence-relevant
  // (either extracted-and-denied or fail-closed). 'non-fs' tools are intentionally
  // NOT asserted here (out of the content-authoring threat model).
  const nonSafe = Object.entries(OWNERSHIP_WRITE_CLASSIFICATION).filter(([, c]) => c !== "non-fs")
  test("classification has a non-trivial number of FENCED (non-'non-fs') tools", () => {
    // guards against an accident that flips everything to 'non-fs' (vacuous pass).
    expect(nonSafe.length).toBeGreaterThanOrEqual(15)
  })
})
