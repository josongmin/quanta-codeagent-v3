/**
 * PMX-04 — `campaign-golden.json` derivation.
 *
 * The pinned `test_run.py` reads its `--golden` file and does
 * `image_name = golden_entry.get("image_name") or f"key4127/refactor-dockerhub:{instance_id}"`,
 * then `docker pull {image_name}` as a SHELL STRING. A mutable tag there means
 * the image content behind an instance can change between two runs of the same
 * campaign, and the evaluator is immutable so we cannot fix it there.
 *
 * The only legal repair is MECHANICAL: take the verified source document and
 * replace EXACTLY ONE field per row — `image_name` — with its digest-pinned
 * reference. This file proves the derivation is exactly that and nothing more:
 * a structural diff over the two documents must report changes on `image_name`
 * and refuse anything else, including array REORDERING (which upstream's
 * `lang_map` / `repo_map` build order depends on) and key add/remove.
 *
 * Everything here is bytes-in/bytes-out. No Docker, no network, no filesystem.
 */
import { describe, expect, test } from "bun:test"
import {
  assertGoldenDerivationIsImageOnly,
  deriveCampaignGolden,
  diffGoldenDocuments,
  GOLDEN_DIFF_VIOLATION_REASONS,
  type GoldenDiffViolationCode,
} from "@/apps/bench/harness/promax"
import { sha256Hex } from "@/apps/bench/promax/provenance"

/**
 * A source document shaped like the REAL upstream corpus at the pinned commit:
 * rows are NOT key-uniform (row 2 has no `environment_setup_commit`), `created_at`
 * is an INTEGER, and one row carries a nested object — all three are upstream
 * facts recorded in PMX-00, and all three are things a naive
 * "JSON.parse → re-serialize" derivation gets wrong.
 */
const SOURCE_ROWS = [
  {
    instance_id: "promax__alpha-1",
    repo: "acme/alpha",
    base_commit: "1111111111111111111111111111111111111111",
    problem_statement: "alpha is broken",
    language: "rust",
    patch: "diff --git a/x b/x\n",
    test_patch: "diff --git a/t b/t\n",
    image_name: "key4127/refactor-dockerhub:promax__alpha-1",
    working_dir: "/workspace/alpha",
    environment_setup_commit: "2222222222222222222222222222222222222222",
    created_at: 1735689600,
    meta: { flaky: false, tags: ["a", "b"] },
  },
  {
    instance_id: "promax__beta-2",
    repo: "acme/beta",
    base_commit: "3333333333333333333333333333333333333333",
    problem_statement: "beta is broken",
    language: "java",
    patch: "diff --git a/y b/y\n",
    test_patch: "diff --git a/u b/u\n",
    image_name: "key4127/refactor-dockerhub:promax__beta-2",
    working_dir: "/testbed",
    created_at: 1735689601,
  },
]

const sourceText = JSON.stringify(SOURCE_ROWS, null, 2)

const PINS = [
  {
    instanceId: "promax__alpha-1",
    pinnedReference: `key4127/refactor-dockerhub@sha256:${"a".repeat(64)}`,
  },
  {
    instanceId: "promax__beta-2",
    pinnedReference: `key4127/refactor-dockerhub@sha256:${"b".repeat(64)}`,
  },
]

const deriveOk = (): { json: string; sourceSha256: string; derivedSha256: string } => {
  const r = deriveCampaignGolden({ sourceText, pins: PINS })
  if (!r.ok) throw new Error(`derivation refused: ${JSON.stringify(r.failures)}`)
  return { json: r.json, sourceSha256: r.sourceSha256, derivedSha256: r.derivedSha256 }
}

describe("PMX-04 campaign-golden derivation — mechanical, image_name only", () => {
  test("replaces ONLY image_name; every other field and the array ORDER survive verbatim", () => {
    const derived = deriveOk()
    const diff = diffGoldenDocuments(sourceText, derived.json)
    if (!diff.ok) throw new Error(`diff refused: ${JSON.stringify(diff.failures)}`)

    // The permitted change set, exhaustively: one per row, field `image_name`.
    expect(diff.violations).toEqual([])
    expect(diff.changes.map((c) => [c.index, c.instanceId, c.field])).toEqual([
      [0, "promax__alpha-1", "image_name"],
      [1, "promax__beta-2", "image_name"],
    ])
    expect(diff.changes.map((c) => c.to)).toEqual(PINS.map((p) => p.pinnedReference))

    // The assertion helper agrees (this is the production gate, not the test's
    // own re-derivation of the rule).
    expect(assertGoldenDerivationIsImageOnly(diff, PINS)).toEqual([])
  })

  test("the derived document preserves non-uniform keys, integer types and nested values", () => {
    const derived = deriveOk()
    const rows = JSON.parse(derived.json) as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    // key sets survive exactly — row 2 still has NO environment_setup_commit
    expect(Object.keys(rows[0] ?? {})).toEqual(Object.keys(SOURCE_ROWS[0] ?? {}))
    expect(Object.keys(rows[1] ?? {})).toEqual(Object.keys(SOURCE_ROWS[1] ?? {}))
    // created_at stays an INTEGER (not "1735689600")
    expect(rows[0]?.created_at).toBe(1735689600)
    expect(typeof rows[0]?.created_at).toBe("number")
    // nested object survives structurally
    expect(rows[0]?.meta).toEqual({ flaky: false, tags: ["a", "b"] })
    // working_dir is RECORDED, never rewritten to /testbed
    ;[
      ["/workspace/alpha", 0],
      ["/testbed", 1],
    ].forEach(([expected, i]) => {
      expect(rows[Number(i)]?.working_dir).toBe(expected)
    })
  })

  test("BOTH file digests are preserved and are digests of the EXACT bytes", () => {
    const derived = deriveOk()
    expect(derived.sourceSha256).toBe(sha256Hex(sourceText))
    expect(derived.derivedSha256).toBe(sha256Hex(derived.json))
    // The derivation genuinely changed the bytes — a no-op derivation that
    // returned the source verbatim would make every claim above vacuous.
    expect(derived.derivedSha256).not.toBe(derived.sourceSha256)
    expect(derived.json).not.toBe(sourceText)
  })

  test("a mutable tag never survives into the derived golden", () => {
    const derived = deriveOk()
    expect(derived.json).not.toContain("refactor-dockerhub:promax__alpha-1")
    expect(derived.json).not.toContain("refactor-dockerhub:promax__beta-2")
    for (const pin of PINS) expect(derived.json).toContain(pin.pinnedReference)
  })
})

describe("PMX-04 structural diff — every non-image_name delta is a VIOLATION", () => {
  const mutate = (fn: (rows: Record<string, unknown>[]) => void): string => {
    const rows = JSON.parse(deriveOk().json) as Record<string, unknown>[]
    fn(rows)
    return JSON.stringify(rows, null, 2)
  }

  const violationCodes = (derivedText: string): readonly GoldenDiffViolationCode[] => {
    const diff = diffGoldenDocuments(sourceText, derivedText)
    if (!diff.ok) throw new Error(`diff refused: ${JSON.stringify(diff.failures)}`)
    return diff.violations.map((v) => v.code)
  }

  test("a changed non-image field is `field_changed`", () => {
    expect(
      violationCodes(mutate((rows) => Object.assign(rows[0] ?? {}, { patch: "tampered" }))),
    ).toEqual(["field_changed"])
  })

  test("a changed working_dir is `field_changed` (recorded, never rewritten)", () => {
    expect(
      violationCodes(mutate((rows) => Object.assign(rows[0] ?? {}, { working_dir: "/testbed" }))),
    ).toEqual(["field_changed"])
  })

  test("an added field is `field_added`", () => {
    expect(
      violationCodes(mutate((rows) => Object.assign(rows[0] ?? {}, { quanta_note: "hi" }))),
    ).toEqual(["field_added"])
  })

  test("a removed field is `field_removed`", () => {
    expect(
      violationCodes(
        mutate((rows) => {
          delete (rows[0] ?? {}).meta
        }),
      ),
    ).toEqual(["field_removed"])
  })

  test("REORDERING the array is `row_order_changed`, not silently accepted", () => {
    const codes = violationCodes(mutate((rows) => rows.reverse()))
    expect(codes).toContain("row_order_changed")
  })

  test("dropping a row is `row_count_changed`", () => {
    expect(violationCodes(mutate((rows) => void rows.pop()))).toEqual(["row_count_changed"])
  })

  test("a nested-value edit is caught (deep comparison, not reference/shallow)", () => {
    expect(
      violationCodes(
        mutate((rows) => Object.assign(rows[0] ?? {}, { meta: { flaky: true, tags: ["a", "b"] } })),
      ),
    ).toEqual(["field_changed"])
  })

  test("assertGoldenDerivationIsImageOnly surfaces the violations it was given", () => {
    const tampered = mutate((rows) => Object.assign(rows[0] ?? {}, { patch: "tampered" }))
    const diff = diffGoldenDocuments(sourceText, tampered)
    if (!diff.ok) throw new Error("diff refused")
    const problems = assertGoldenDerivationIsImageOnly(diff, PINS)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("field_changed")
    expect(problems[0]).toContain("promax__alpha-1")
  })

  test("every violation code has a reason (exhaustive Record + runtime drift guard)", () => {
    const codes = Object.keys(GOLDEN_DIFF_VIOLATION_REASONS) as GoldenDiffViolationCode[]
    expect(codes.length).toBeGreaterThanOrEqual(5)
    for (const code of codes) expect(GOLDEN_DIFF_VIOLATION_REASONS[code].length).toBeGreaterThan(0)
  })
})

describe("PMX-04 campaign-golden derivation — fail-closed inputs", () => {
  const codesOf = (input: Parameters<typeof deriveCampaignGolden>[0]): readonly string[] => {
    const r = deriveCampaignGolden(input)
    return r.ok ? [] : r.failures.map((f) => f.code)
  }

  test("an instance with NO pin refuses — it would fall back to the mutable tag", () => {
    expect(codesOf({ sourceText, pins: [PINS[0] as (typeof PINS)[number]] })).toEqual([
      "pin_missing",
    ])
  })

  test("a pin that is not digest-addressed refuses", () => {
    expect(
      codesOf({
        sourceText,
        pins: [
          PINS[0] as (typeof PINS)[number],
          { instanceId: "promax__beta-2", pinnedReference: "key4127/refactor-dockerhub:latest" },
        ],
      }),
    ).toEqual(["pin_not_digest"])
  })

  test("a pin for an instance not in the source refuses (never silently ignored)", () => {
    expect(
      codesOf({
        sourceText,
        pins: [...PINS, { instanceId: "ghost-9", pinnedReference: `r@sha256:${"c".repeat(64)}` }],
      }),
    ).toEqual(["pin_unknown_instance"])
  })

  test("a row whose source image_name is blank refuses (upstream would substitute a tag)", () => {
    const blank = JSON.stringify(
      SOURCE_ROWS.map((r, i) => (i === 0 ? { ...r, image_name: "  " } : r)),
      null,
      2,
    )
    expect(codesOf({ sourceText: blank, pins: PINS })).toEqual(["image_name_absent"])
  })

  test("unparseable / non-array source refuses rather than deriving from nothing", () => {
    expect(codesOf({ sourceText: "{", pins: PINS })).toEqual(["source_unparseable"])
    expect(codesOf({ sourceText: '{"a":1}', pins: PINS })).toEqual(["source_not_array"])
  })

  test("a duplicated instance_id refuses (two rows would race for one pin)", () => {
    const dup = JSON.stringify([...SOURCE_ROWS, SOURCE_ROWS[0]], null, 2)
    expect(codesOf({ sourceText: dup, pins: PINS })).toContain("instance_id_duplicated")
  })
})
