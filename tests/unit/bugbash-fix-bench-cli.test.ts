/**
 * Bug-bash group `bench-cli` (jun-20) — fixes #17, #18, #19.
 *
 *   #17 (efficiency): the dataset JSONL was read + JSON-parsed 3× per run (empty
 *        check + filter + the discarded dry-run-plan parse). Parse ONCE and thread
 *        the parsed corpus through. Teeth: drive `runMain` over a dataset whose
 *        `--instance` filter selects 0 tasks (so the LLM is never invoked) and spy
 *        `node:fs.readFileSync` — the dataset file is read EXACTLY once. Revert ⇒ 3.
 *
 *   #18 (correctness): `--max-workers 0` / `-5` slipped through `Number.isInteger`
 *        and shipped `--max_workers -5` verbatim to the remote swebench harness.
 *        `parseMaxWorkers` now rejects zero/negative/garbage. Teeth: those raws are
 *        `{ ok: false }`; a positive int is `{ ok: true, value }`.
 *
 *   #19 (correctness): `--skip-resolved` cast `resolved_ids` to `string[]` with no
 *        filtering, letting numbers/nulls pollute the skip set + merged tally.
 *        `resolvedIdsFromReport` filters to non-empty strings (and decodes the
 *        double-encoded-JSON-string export form). Teeth: a mixed array drops the
 *        non-strings; a malformed entry never crashes.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMain } from "@/apps/bench"
import { parseMaxWorkers, resolvedIdsFromReport } from "@/apps/bench/commands/shared"

describe("#17 — dataset JSONL parsed ONCE per run (single read)", () => {
  let dir: string
  let datasetFile: string
  const savedArgv = process.argv
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "QUANTA_PROVIDER",
    "QUANTA_SWEBENCH_DATASET",
    "QUANTA_SWEBENCH_PYTHON",
    "QUANTA_OBSERVE_DIR",
    "QUANTA_BENCH_PRESET",
    "QUANTA_BENCH_SOTA",
    "QUANTA_RUN_ID",
  ]

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
    dir = mkdtempSync(join(tmpdir(), "bugbash-17-"))
    datasetFile = join(dir, "instances.jsonl")
    // Two real rows so the RAW empty-check passes; the run path is then exercised.
    const rows = [
      JSON.stringify({
        instance_id: "demo__inst-1",
        repo: "demo/repo",
        base_commit: "0".repeat(40),
        problem_statement: "fix one",
      }),
      JSON.stringify({
        instance_id: "demo__inst-2",
        repo: "demo/repo",
        base_commit: "1".repeat(40),
        problem_statement: "fix two",
      }),
    ].join("\n")
    writeFileSync(datasetFile, `${rows}\n`)
    // A fake key makes `tryCreateLLM("openai")` build a port WITHOUT any wire call;
    // `--instance __none__` selects 0 tasks so `.stream()` is never invoked.
    process.env.OPENAI_API_KEY = "sk-test-bugbash"
    delete process.env.ANTHROPIC_API_KEY
    process.env.QUANTA_PROVIDER = "openai"
    delete process.env.QUANTA_SWEBENCH_PYTHON
    delete process.env.QUANTA_SWEBENCH_DATASET
    process.env.QUANTA_OBSERVE_DIR = join(dir, "observe")
    process.env.QUANTA_BENCH_PRESET = ""
    process.env.QUANTA_BENCH_SOTA = ""
    process.env.QUANTA_RUN_ID = `bugbash-17-${Date.now()}`
  })

  afterEach(() => {
    process.argv = savedArgv
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test("the dataset file is read EXACTLY once across a full run (revert ⇒ 3)", async () => {
    process.argv = [
      "bun",
      "src/apps/bench/index.ts",
      "--swebench",
      datasetFile,
      "--instance",
      "__no_such_instance__", // selects 0 tasks ⇒ never touches the LLM
      "--predictions",
      join(dir, "preds.jsonl"),
      "--report",
      join(dir, "report.json"),
    ]
    const spy = spyOn(fs, "readFileSync")
    try {
      // Injected no-op exit so a guidance-exit can't kill the test runner.
      await runMain({ exit: (() => undefined) as never })
      const datasetReads = spy.mock.calls.filter((c) => {
        const arg = c[0]
        return typeof arg === "string" && arg === datasetFile
      }).length
      // Prove the spy is live AND the parse-once invariant: exactly one read.
      expect(datasetReads).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("#18 — parseMaxWorkers rejects zero / negative / garbage", () => {
  test("absent ⇒ ok with no value (backend default applies)", () => {
    expect(parseMaxWorkers(undefined)).toEqual({ ok: true })
    expect(parseMaxWorkers("")).toEqual({ ok: true })
    expect(parseMaxWorkers("   ")).toEqual({ ok: true })
  })

  test("positive integer ⇒ ok with that value", () => {
    expect(parseMaxWorkers("4")).toEqual({ ok: true, value: 4 })
    expect(parseMaxWorkers("1")).toEqual({ ok: true, value: 1 })
  })

  test("zero is rejected (was shipped verbatim as --max_workers 0)", () => {
    expect(parseMaxWorkers("0")).toEqual({ ok: false, raw: "0" })
  })

  test("negative is rejected (was shipped verbatim as --max_workers -5)", () => {
    expect(parseMaxWorkers("-5")).toEqual({ ok: false, raw: "-5" })
  })

  test("non-integer garbage is rejected", () => {
    expect(parseMaxWorkers("abc")).toEqual({ ok: false, raw: "abc" })
    expect(parseMaxWorkers("2.5")).toEqual({ ok: false, raw: "2.5" })
  })
})

describe("#19 — resolvedIdsFromReport filters non-strings", () => {
  test("a mixed array drops numbers/nulls/empties, keeps strings", () => {
    expect(resolvedIdsFromReport(["a__1", 7, null, "", "b__2", undefined, {}])).toEqual([
      "a__1",
      "b__2",
    ])
  })

  test("a non-string entry does not crash and is filtered out", () => {
    // Reverting to the raw `as string[]` cast would let the number survive into
    // the skip set + merged tally; the filtered result keeps only the string.
    expect(() => resolvedIdsFromReport([42])).not.toThrow()
    expect(resolvedIdsFromReport([42])).toEqual([])
  })

  test("accepts the double-encoded-JSON-string export form", () => {
    expect(resolvedIdsFromReport('["x__1","x__2"]')).toEqual(["x__1", "x__2"])
  })

  test("non-array / unparseable ⇒ []", () => {
    expect(resolvedIdsFromReport(undefined)).toEqual([])
    expect(resolvedIdsFromReport(123)).toEqual([])
    expect(resolvedIdsFromReport("not-json")).toEqual([])
  })
})
