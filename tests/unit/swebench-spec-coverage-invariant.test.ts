/**
 * SOTA++ keystone invariant (jun-27): EVERY SWE-bench Verified instance's
 * (repo, version) MUST have a spec entry in `repo-version-specs.ts`.
 *
 * Why this is load-bearing: the in-loop test runner is chosen by
 * `specRunnerKind(repo, version)`. If a (repo, version) is UNMAPPED, the exact
 * lookup is undefined — for a django version that slips through it would route to
 * the pytest oracle (django can't run under pytest → the engage=0 RCA). The
 * `specRunnerKind` fallback now infers the kind from the repo's other versions
 * (drift-resilient), but the REAL guarantee is this test: if SWE-bench ships a new
 * version, or the spec regen drifts, coverage drops below 100% and CI goes RED
 * here — BEFORE any run silently mis-resolves. (Manually verified 80/80 once;
 * this pins it forever.)
 *
 * Reads the committed Verified dataset; visibly skips if it is absent (so a
 * checkout without the rawdata file does not fail) — but when present, demands
 * 100% coverage and correct django-vs-pytest classification.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { hasRepoVersionSpec, specRunnerKind } from "@/runner/batch/corpus/repo-version-specs"

const DATASET = join(
  import.meta.dir,
  "..",
  "..",
  "tools/leaderboard-dashboard/rawdata/verified-full.jsonl",
)

interface Row {
  readonly repo?: unknown
  readonly version?: unknown
  readonly instance_id?: unknown
}

const readDataset = (): Array<{ repo: string; version: string; id: string }> => {
  const rows: Array<{ repo: string; version: string; id: string }> = []
  for (const line of readFileSync(DATASET, "utf8").split("\n")) {
    if (line.trim() === "") continue
    let j: Row
    try {
      j = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (typeof j.repo === "string" && j.version !== undefined) {
      rows.push({
        repo: j.repo,
        version: String(j.version),
        id: typeof j.instance_id === "string" ? j.instance_id : "?",
      })
    }
  }
  return rows
}

describe("SWE-bench Verified spec-coverage invariant", () => {
  test("every (repo, version) in the Verified dataset has a spec entry — 100% coverage", () => {
    if (!existsSync(DATASET)) {
      // biome-ignore lint/suspicious/noConsole: visible skip when the rawdata file is absent
      console.log(`[skip] ${DATASET} absent — coverage invariant not checked in this checkout`)
      return
    }
    const rows = readDataset()
    expect(rows.length).toBeGreaterThan(0) // dataset actually parsed (not vacuous)
    const missing = rows
      .filter((r) => !hasRepoVersionSpec(r.repo, r.version))
      .map((r) => `${r.id} (${r.repo}@${r.version})`)
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} Verified instance(s) lack a repo-version-specs entry — ` +
          "regenerate via `bun tools/dev/regen-repo-version-specs.ts` (the runner would " +
          `mis-resolve these):\n  ${missing.slice(0, 20).join("\n  ")}`,
      )
    }
    expect(missing.length).toBe(0)
  })

  test("classification holds across the whole dataset: django ⇒ runtests, every other repo ⇒ pytest", () => {
    if (!existsSync(DATASET)) {
      // biome-ignore lint/suspicious/noConsole: visible skip when the rawdata file is absent
      console.log(`[skip] ${DATASET} absent — classification invariant not checked`)
      return
    }
    const rows = readDataset()
    const wrong: string[] = []
    for (const r of rows) {
      const kind = specRunnerKind(r.repo, r.version)
      const expected = r.repo === "django/django" ? "runtests" : "pytest"
      if (kind !== expected)
        wrong.push(`${r.id} (${r.repo}@${r.version}): ${kind}, expected ${expected}`)
    }
    if (wrong.length > 0) {
      throw new Error(`runner mis-classification:\n  ${wrong.slice(0, 20).join("\n  ")}`)
    }
    expect(wrong.length).toBe(0)
  })
})
