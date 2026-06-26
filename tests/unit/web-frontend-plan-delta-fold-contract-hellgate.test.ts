import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ALL_PLAN_DELTA_KIND_MIRROR } from "@/stream"

/**
 * Plan-delta producer↔consumer fold contract (hellgate).
 *
 * The daemon EMITS granular plan deltas in the closed `PlanDeltaKindMirror`
 * taxonomy (`src/stream/types.ts`, SSOT `ALL_PLAN_DELTA_KIND_MIRROR`). The web
 * frontend FOLDS each delta back onto a live plan in `applyPlanDelta`
 * (`apps/web-frontend/src/ws/plan-reducer.ts`, a SEPARATE toolchain that cannot
 * `import` from `@/`). Its `FOLDERS` dispatch table has a forward-compat
 * fallback: a delta kind ABSENT from the table is silently dropped (the plan is
 * returned unchanged). So a new kind added to the daemon — even one correctly
 * mirrored in the frontend's `AgentStatePlanDeltaKind` TYPE copy (which the
 * existing agent-state drift hellgate would pass) — would be SILENTLY IGNORED by
 * the reducer with no test going red.
 *
 * The audit flagged exactly this: nothing tied the frontend's fold to the
 * daemon's emission. THIS guard does. It imports the canonical kind list and
 * reads the frontend reducer AS TEXT (different toolchain), extracts the
 * `FOLDERS` dispatch keys as INDEPENDENT TEXT ANCHORS (never referencing the
 * imported set, so the comparison is load-bearing, not tautological), then
 * asserts set-equality in BOTH directions. It also pins the frontend TYPE mirror
 * (`AgentStatePlanDeltaKind`) and the `todo_added → status:"pending"` default
 * (the producer omits a status on add, so the reducer default is the SOLE
 * source — a silent change there diverges the rendered plan).
 *
 * SSOT is the daemon. To add a kind: edit `PlanDeltaKindMirror` +
 * `ALL_PLAN_DELTA_KIND_MIRROR` FIRST, then add a `FOLDERS` entry + mirror the
 * frontend `AgentStatePlanDeltaKind` type until this test is green again.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..")
const REDUCER_PATH = join(REPO_ROOT, "apps/web-frontend/src/ws/plan-reducer.ts")
const FRONTEND_PROTOCOL_PATH = join(REPO_ROOT, "apps/web-frontend/src/types/protocol.ts")

const readText = (path: string): string => readFileSync(path, "utf8")

/** Extract the dispatch keys of the frontend `FOLDERS` object — the kinds the
 *  reducer actually folds. Scoped to the `const FOLDERS … = { … }` block so a
 *  stray `kind:` elsewhere cannot leak in; each entry is `  <kind>: fold…,`. */
const extractFolderKeys = (source: string): Set<string> => {
  const block = /const FOLDERS:[\s\S]*?=\s*\{([\s\S]*?)\n\}/.exec(source)?.[1]
  if (block === undefined) throw new Error("FOLDERS dispatch block not found in plan-reducer.ts")
  const keys = new Set<string>()
  for (const m of block.matchAll(/^\s*([a-z_]+)\s*:/gm)) {
    if (m[1]) keys.add(m[1])
  }
  return keys
}

/** Extract the frontend's hand-copied `AgentStatePlanDeltaKind` union literals. */
const extractTypeKinds = (source: string): Set<string> => {
  const block = /export type AgentStatePlanDeltaKind\s*=([\s\S]*?)(?:\n\n|\nexport |\n\/\*)/.exec(
    source,
  )?.[1]
  if (block === undefined) throw new Error("AgentStatePlanDeltaKind union not found in protocol.ts")
  const kinds = new Set<string>()
  for (const m of block.matchAll(/"([a-z_]+)"/g)) {
    if (m[1]) kinds.add(m[1])
  }
  return kinds
}

const CANONICAL = new Set<string>(ALL_PLAN_DELTA_KIND_MIRROR)

describe("plan-delta fold contract — daemon emit ↔ frontend fold", () => {
  const reducerSrc = readText(REDUCER_PATH)
  const protocolSrc = readText(FRONTEND_PROTOCOL_PATH)
  const folderKeys = extractFolderKeys(reducerSrc)
  const typeKinds = extractTypeKinds(protocolSrc)

  test("the extractors are non-vacuous (teeth — a parse miss must not pass silently)", () => {
    // This size floor is the BACKSTOP against a silent regex miss: the `[a-z_]+`
    // kind matcher cannot see a future kind with a digit/uppercase, and a frontend
    // reformat could make a block regex over- or under-capture. Any such miss
    // changes a `.size` and trips THIS test (red), so a miss is never a false PASS.
    // 5 canonical kinds today; if the SSOT shrinks below this the constant moves.
    expect(CANONICAL.size).toBe(5)
    expect(folderKeys.size).toBe(CANONICAL.size)
    expect(typeKinds.size).toBe(CANONICAL.size)
  })

  test("frontend FOLDERS folds EVERY canonical kind (no silent drop)", () => {
    const unfolded = [...CANONICAL].filter((k) => !folderKeys.has(k))
    expect(unfolded).toEqual([])
  })

  test("frontend FOLDERS has NO fold for a non-canonical kind (no orphan handler)", () => {
    const orphan = [...folderKeys].filter((k) => !CANONICAL.has(k))
    expect(orphan).toEqual([])
  })

  test("frontend AgentStatePlanDeltaKind TYPE mirror matches canonical both ways", () => {
    expect([...CANONICAL].filter((k) => !typeKinds.has(k))).toEqual([])
    expect([...typeKinds].filter((k) => !CANONICAL.has(k))).toEqual([])
  })

  test('todo_added default-status contract: reducer hard-codes status:"pending"', () => {
    // The producer emits `todo_added` WITHOUT a status, so the reducer default is
    // the sole source of a new todo's rendered status. Pin it so a silent change
    // (e.g. to "in_progress") is visible as a contract break, not a UI mystery.
    const fold = /const foldTodoAdded[\s\S]*?status:\s*"([a-z_]+)"/.exec(reducerSrc)?.[1]
    expect(fold).toBe("pending")
  })

  test("CONTROL (teeth): the fold-coverage check FIRES on a synthetic missing kind", () => {
    // Prove the guard is load-bearing: a reducer missing `plan_renamed` must fail.
    const synthetic = reducerSrc.replace(/^\s*plan_renamed:\s*foldPlanRenamed,\s*$/m, "")
    const keys = extractFolderKeys(synthetic)
    const unfolded = [...CANONICAL].filter((k) => !keys.has(k))
    expect(unfolded).toContain("plan_renamed")
  })
})
