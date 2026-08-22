import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSwebenchJsonl } from "../../src/apps/bench/corpus/dataset"
import { PINNED, type Row, violations } from "../smoke/swebench/select"

/**
 * Guard for the FROZEN SWE-bench Verified smoke baseline (see
 * tests/smoke/swebench/README.md). This runs offline against the COMMITTED
 * picks.jsonl — no network, no LLM — so it is a deterministic "always-pass"
 * gate on the baseline DEFINITION: it fails the moment picks.jsonl drifts from
 * the pinned set or stops satisfying the smoke-grade criteria. (Model-capability
 * replay is a separate, key-gated layer.)
 */
const PICKS = join(import.meta.dir, "../smoke/swebench/picks.jsonl")
const raw = readFileSync(PICKS, "utf8")
const rows = parseSwebenchJsonl(raw).map((t) => t.raw as Row)

describe("swebench smoke picks (frozen baseline)", () => {
  test("picks.jsonl contains exactly the pinned instances, in order", () => {
    expect(rows.map((r) => r.instance_id)).toEqual([...PINNED])
  })

  test("every pick still satisfies the smoke-grade criteria", () => {
    const offenders = rows
      .map((r) => ({ id: r.instance_id, v: violations(r) }))
      .filter((x) => x.v.length > 0)
    expect(offenders).toEqual([])
  })

  test("every pick is runnable by the bench loader (required fields present)", () => {
    const tasks = parseSwebenchJsonl(raw)
    expect(tasks).toHaveLength(PINNED.length)
    for (const t of tasks) {
      expect(t.instanceId.length).toBeGreaterThan(0)
      expect(t.repo).toContain("/")
      expect(t.baseCommit).toMatch(/^[0-9a-f]{40}$/)
      expect(t.problemStatement.length).toBeGreaterThan(0)
    }
  })
})
