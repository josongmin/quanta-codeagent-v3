/**
 * PMX-A1 — the ProMax row-field CLASSIFICATION and its two-way bind.
 *
 * WHY THIS FILE EXISTS. `promax-projection.ts` calls itself the "fail-safe
 * floor" for packet invariant 3, but its deny-list named exactly TWO keys
 * (`patch`, `test_patch`) while PMX-02's grader view carries SIX row-derived
 * fields and the real 170-row corpus carries a seventh withheld one
 * (`hints_text`). The floor was fail-OPEN and nothing tied it to the grader view.
 *
 * WHAT IS PROVEN HERE, each against a REAL production entry point:
 *  1. DEFAULT PATH — `assertDatasetGradeableForFamily` (the callee both the
 *     full-remote and pool roots run BEFORE a box is provisioned) refuses a
 *     chunk that carries grader/withheld fields, not just gold bodies.
 *  2. TWO-WAY BIND — every row field classified `grader` maps to a real
 *     `PromaxGraderTaskView` key, and every grader-view key is accounted for.
 *  3. REAL CORPUS — every key OBSERVED across the actual 170-row upstream
 *     dataset is classified. A fixture-only proof would have missed
 *     `hints_text`, which is the field that motivated this.
 *
 * ⚠️ SPEND SAFETY: nothing here provisions, uploads, pulls or bills. Every call
 * is a pure resolver over local bytes.
 * ⚠️ LIVE-DATA: no report write; `~/.quanta/bench/results` is untouched.
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { loadFamilyCorpusRowsOrThrow } from "@/apps/bench/profiles/corpus-read"
import { assertProMaxDatasetShape } from "@/apps/bench/profiles/promax-dataset-shape"
import {
  assertProMaxFieldClassificationInSync,
  PROMAX_GRADER_ROW_FIELD_TO_VIEW_KEY,
  PROMAX_GRADER_VIEW_FIELD_SOURCE,
  PROMAX_NON_AGENT_ROW_FIELDS,
  PROMAX_ROW_FIELD_DESTINATION,
  PROMAX_ROW_FIELDS,
  PROMAX_V1_FIELD_PRESENCE,
  type ProMaxFieldDestination,
  type ProMaxRowField,
} from "@/apps/bench/profiles/promax-field-class"
import { projectProMaxRowForAgent } from "@/apps/bench/profiles/promax-projection"
import { assertDatasetGradeableForFamily } from "@/apps/bench/remote/box-session/dataset-preflight"
import { errMessage } from "@/shared"

// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A row shaped like the REAL upstream corpus: all 12 always-present fields plus
 *  the sparse `pull_number`. Field names/spellings taken from the real dataset. */
const upstreamRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  instance_id: "key4127__promax-1",
  repo: "acme/widget",
  base_commit: "a".repeat(40),
  environment_setup_commit: "b".repeat(40),
  language: "rust",
  image_name: "promax/acme-widget:pinned",
  working_dir: "/testbed",
  problem_statement: "the widget does not widget",
  hints_text: "HINT: the fix is to widen the buffer in src/lib.rs",
  patch: "diff --git a/src/lib.rs b/src/lib.rs\n+GOLD PATCH BODY\n",
  test_patch: "diff --git a/tests/t.rs b/tests/t.rs\n+GOLD TEST BODY\n",
  created_at: 1_700_000_000,
  pull_number: 4127,
  ...over,
})

const writeJsonl = (name: string, rows: ReadonlyArray<Record<string, unknown>>): string => {
  const dir = mkdtempSync(join(tmpdir(), "pmx-a1-"))
  const path = join(dir, name)
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"))
  return path
}

const promaxRows = (path: string) =>
  loadFamilyCorpusRowsOrThrow({ datasetPath: path, surface: "t", family: "promax" })

const refusalFor = (rows: ReadonlyArray<Record<string, unknown>>): string => {
  const path = writeJsonl("chunk.jsonl", rows)
  try {
    assertProMaxDatasetShape({ rows: promaxRows(path), surface: "t" })
  } catch (err) {
    return errMessage(err)
  }
  return ""
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 — DEFAULT PRODUCTION PATH: the floor refuses more than the two gold bodies
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-A1 — the deny-list floor covers the WHOLE grader/withheld class", () => {
  test("a gold-STRIPPED chunk that still carries grader + withheld fields is REFUSED", () => {
    // Exactly what an operator produces by "removing the gold": the two patch
    // bodies are gone, everything else survives. This is the chunk that would be
    // scp'd to the box the agent runs on.
    const stripped = upstreamRow()
    delete stripped.patch
    delete stripped.test_patch

    const message = refusalFor([stripped])
    expect(message).toMatch(/GRADER-ONLY/)
    for (const key of [
      "hints_text",
      "image_name",
      "working_dir",
      "environment_setup_commit",
    ] as const) {
      expect(message, `chunk carrying \`${key}\` must be refused`).toContain(key)
    }
    // The refusal still reports NAMES only — never a body it is refusing.
    expect(message).not.toContain("the fix is to widen the buffer")
  })

  test("PAIRED CONTROL — the row the REAL projection emits clears the same check", () => {
    const projected = projectProMaxRowForAgent(upstreamRow())
    expect(refusalFor([projected])).toBe("")
    // …and the projection kept the PUBLIC metadata the shape check needs, so the
    // control is not passing by having emptied the row.
    for (const key of ["instance_id", "repo", "base_commit", "problem_statement", "language"]) {
      expect(Object.keys(projected)).toContain(key)
    }
    // sparse public metadata survives (the documented reason this is a deny-list)
    expect(projected.pull_number).toBe(4127)
    expect(projected.created_at).toBe(1_700_000_000)
  })

  test("DEFAULT-PATH WIRING — the same refusal arrives through the real preflight callee", () => {
    const stripped = upstreamRow()
    delete stripped.patch
    delete stripped.test_patch
    const path = writeJsonl("preflight.jsonl", [stripped])
    let message = ""
    try {
      assertDatasetGradeableForFamily({
        datasetPath: path,
        surface: "full-remote",
        family: "promax",
      })
    } catch (err) {
      message = errMessage(err)
    }
    expect(message).toMatch(/GRADER-ONLY/)
    expect(message).toContain("hints_text")
    // PAIRED: verified/live are untouched — no global gate was armed.
    for (const family of ["verified", "live"] as const) {
      expect(() =>
        assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family }),
      ).not.toThrow()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 — the CLOSED classification and its TWO-WAY bind to PromaxGraderTaskView
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-A1 — the classification is closed and bound both ways", () => {
  test("the runtime drift guard passes on the shipped tables", () => {
    expect(() => assertProMaxFieldClassificationInSync()).not.toThrow()
  })

  test("classification is TOTAL over the declared field set, in both directions", () => {
    expect(([...PROMAX_ROW_FIELDS] as string[]).sort()).toEqual(
      Object.keys(PROMAX_ROW_FIELD_DESTINATION).sort(),
    )
    // KNOWN-ITEM FLOOR — 14 fields, and the full destination union is USED, so a
    // table that collapsed to one answer fails here.
    expect(PROMAX_ROW_FIELDS.length).toBe(14)
    const used = new Set<ProMaxFieldDestination>(Object.values(PROMAX_ROW_FIELD_DESTINATION))
    expect([...used].sort()).toEqual(["agent", "grader", "withheld"])
  })

  test("DIRECTION 1 — every `grader` field lands on a real PromaxGraderTaskView key", () => {
    const graderFields = PROMAX_ROW_FIELDS.filter(
      (f) => PROMAX_ROW_FIELD_DESTINATION[f] === "grader",
    )
    expect([...graderFields].sort()).toEqual([
      "environment_setup_commit",
      "image_name",
      "patch",
      "test_patch",
      "working_dir",
    ])
    const mapped = PROMAX_GRADER_ROW_FIELD_TO_VIEW_KEY as Readonly<Record<string, string>>
    const viewSource = PROMAX_GRADER_VIEW_FIELD_SOURCE as Readonly<Record<string, string>>
    for (const field of graderFields) {
      const viewKey = mapped[field]
      expect(viewKey, `\`${field}\` must name a grader-view key`).toBeDefined()
      expect(viewSource[String(viewKey)]).toBe("row")
    }
  })

  test("DIRECTION 2 — every ROW-sourced grader-view key is produced by a classified field", () => {
    const mappedKeys = new Set(Object.values(PROMAX_GRADER_ROW_FIELD_TO_VIEW_KEY as object))
    const rowSourced = Object.entries(PROMAX_GRADER_VIEW_FIELD_SOURCE).filter(
      ([, source]) => source === "row",
    )
    // KNOWN-ITEM FLOOR — the view really does have five row-sourced fields, plus
    // the join key and the eval-map script that are NOT dataset row fields.
    expect(rowSourced.map(([k]) => k).sort()).toEqual([
      "environmentSetupCommit",
      "imageName",
      "patch",
      "testPatch",
      "workingDir",
    ])
    for (const [viewKey] of rowSourced) expect(mappedKeys.has(viewKey)).toBe(true)
    expect(Object.keys(PROMAX_GRADER_VIEW_FIELD_SOURCE).sort()).toEqual([
      "environmentSetupCommit",
      "evalScript",
      "imageName",
      "instanceId",
      "patch",
      "testPatch",
      "workingDir",
    ])
  })

  test("the deny-list floor IS the derived non-agent set — not a hand-written pair", () => {
    expect([...PROMAX_NON_AGENT_ROW_FIELDS].sort()).toEqual([
      "environment_setup_commit",
      "hints_text",
      "image_name",
      "patch",
      "test_patch",
      "working_dir",
    ])
    // and the projection actually consumes it: every denied field is dropped and
    // every agent field survives, flowed as the FULL union rather than one literal
    const row: Record<string, unknown> = {}
    for (const field of PROMAX_ROW_FIELDS) row[field] = `value-of-${field}`
    const projected = projectProMaxRowForAgent(row)
    for (const field of PROMAX_ROW_FIELDS) {
      const destination = PROMAX_ROW_FIELD_DESTINATION[field]
      if (destination === "agent") {
        expect(projected[field], `agent field \`${field}\` was dropped`).toBe(`value-of-${field}`)
      } else {
        expect(Object.keys(projected), `${destination} field \`${field}\` leaked`).not.toContain(
          field,
        )
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 — REAL CORPUS coverage (the proof a fixture cannot give)
// ─────────────────────────────────────────────────────────────────────────────
const REAL_DATASET = join(homedir(), ".quanta/bench/promax-bundle/v1-170/dataset.json")
/** `PROMAX_V1_SNAPSHOT.dataset_sha256`, restated so this file proves it read the
 *  bytes the frozen snapshot names rather than "some json that was lying there". */
const V1_DATASET_SHA256 = "f1f084836da779f58fe4150fb786d22c54d0f848d232dd3106aeff4b2dfcc7e9"

/** field → number of rows carrying it, over the real corpus. */
const censusOf = (rows: ReadonlyArray<Record<string, unknown>>): Record<string, number> => {
  const census: Record<string, number> = {}
  for (const row of rows) {
    for (const key of Object.keys(row)) census[key] = (census[key] ?? 0) + 1
  }
  return census
}

describe("PMX-A1 — the classification covers the REAL 170-row corpus", () => {
  const present = existsSync(REAL_DATASET)
  if (!present) {
    // VISIBLE skip: the verified bundle is an OPERATOR artifact (9.7MB, gold
    // inline) and is never in git, so this coverage cannot run everywhere. The
    // runner prints it as `(skip)` with the path in the name — a silent `return`
    // would make "0 real-corpus assertions" indistinguishable from "all passed".
    test.skip(`real-corpus coverage — verified v1 bundle absent at ${REAL_DATASET}`, () => {
      expect(existsSync(REAL_DATASET)).toBe(true)
    })
    return
  }

  const bytes = readFileSync(REAL_DATASET)
  const rows = JSON.parse(bytes.toString("utf8")) as ReadonlyArray<Record<string, unknown>>

  test("the bytes read really are the frozen v1 dataset", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(V1_DATASET_SHA256)
    expect(rows).toHaveLength(170)
  })

  test("EVERY key observed on the real corpus is classified — and the census matches", () => {
    const census = censusOf(rows)
    // Totality: an upstream field addition is RED here, which is the whole point
    // (a fixture-only proof would never have seen `hints_text`).
    for (const key of Object.keys(census)) {
      expect(
        [...PROMAX_ROW_FIELDS] as readonly string[],
        `real corpus key \`${key}\` is UNCLASSIFIED`,
      ).toContain(key)
    }
    // …and the reverse: the classification claims no field the corpus lacks.
    expect(Object.keys(census).sort()).toEqual(([...PROMAX_ROW_FIELDS] as string[]).sort())
    // the frozen census is exact, so a removal or a sparsity change is red too
    expect(census).toEqual({ ...PROMAX_V1_FIELD_PRESENCE })
    // KNOWN-ITEM FLOOR — the leaky field and the sparse ones were really seen.
    expect(census.hints_text).toBe(170)
    expect(census.pull_number).toBe(104)
    expect(census.issue_numbers).toBe(3)
  })

  test("the projection strips EVERY non-agent field from all 170 real rows", () => {
    const denied = new Set<string>(PROMAX_NON_AGENT_ROW_FIELDS)
    let strippedTotal = 0
    for (const row of rows) {
      const before = Object.keys(row).filter((k) => denied.has(k))
      strippedTotal += before.length
      const projected = projectProMaxRowForAgent(row)
      for (const key of Object.keys(projected)) {
        expect(denied.has(key), `\`${key}\` survived projection`).toBe(false)
        expect(PROMAX_ROW_FIELD_DESTINATION[key as ProMaxRowField]).toBe("agent")
      }
      // NON-VACUOUS: the projected row is still a runnable public row.
      expect(projected.instance_id).toBe(row.instance_id)
      expect(projected.problem_statement).toBe(row.problem_statement)
    }
    // KNOWN-ITEM FLOOR — 6 denied fields on all 170 rows really were stripped.
    expect(strippedTotal).toBe(170 * 6)
  })

  test("a real gold-bearing row is refused by the preflight naming ALL six fields", () => {
    const first = rows[0]
    expect(first).toBeDefined()
    const message = refusalFor([first as Record<string, unknown>])
    expect(message).toMatch(/GRADER-ONLY/)
    for (const field of PROMAX_NON_AGENT_ROW_FIELDS) expect(message).toContain(field)
    // the refusal is names-only: no gold body, however long the patch is
    expect(message.length).toBeLessThan(600)
  })
})
