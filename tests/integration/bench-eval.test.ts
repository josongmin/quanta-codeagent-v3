/**
 * Real-corpus loader + official Python-harness seam + --dry-run plan.
 *
 * Fully hermetic: no network, no real Python, no Docker, no LLM. The Python
 * harness is exercised through its injectable `spawn`/`probe` boundary; the
 * real-corpus sub-assertion self-skips when the corpus env is unset/absent so
 * the suite stays green anywhere.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadCorpus, writeSyntheticRealCorpus } from "../../src/apps/bench/corpus/loader"
import { buildDatasetDryRunPlan, buildDryRunPlan, formatDryRunPlan } from "../../src/apps/bench/dry-run"
import {
  evaluateWithPythonSwebench,
  isPythonSwebenchAvailable,
  type Spawn,
  SWEBENCH_VERIFIED_DATASET,
} from "../../src/apps/bench/python-swebench"
import type { Instance } from "../../src/apps/bench/types"
import type { SwebenchTask } from "../../src/runner/batch/corpus"

const mkInstance = (
  over: Partial<Instance> = {},
  opts: { noSwebench?: boolean } = {},
): Instance => {
  const base: Instance = {
    id: "demo__demo-1",
    repoPath: "/tmp/does-not-matter",
    problemStatement: "fix it",
    testCmd: "true",
    ...(opts.noSwebench
      ? {}
      : {
          swebench: { instanceId: "demo__demo-1", repo: "demo/demo", baseCommit: "0".repeat(40) },
        }),
  }
  return { ...base, ...over }
}

describe("bench-eval: real corpus loader", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-eval-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(a) loadCorpus parses a dir laid out in the REAL discovered format", async () => {
    const cacheDir = join(dir, "cache", "demo")
    await writeSyntheticRealCorpus(dir, cacheDir)

    const corpus = await loadCorpus(dir)
    expect(corpus).toHaveLength(1)
    const inst = corpus[0] as Instance
    expect(inst.id).toBe("py.repo.swebench_demo.001")
    expect(inst.repoPath).toBe(cacheDir)
    expect(inst.problemStatement).toContain("demo bug")
    expect(inst.testCmd).toBe("python -m pytest -q test_mod.py")
    expect(inst.swebench).toEqual({
      instanceId: "demo__demo-1",
      repo: "demo/demo",
      baseCommit: "0".repeat(40),
      environmentSetupCommit: "1".repeat(40),
    })
  })

  test("(a') a task whose repo_ref has no cached checkout is skipped", async () => {
    const cacheDir = join(dir, "cache", "demo")
    await writeSyntheticRealCorpus(dir, cacheDir)
    // Point the only task at an unknown repo by nuking the repo manifest dir.
    rmSync(join(dir, "external"), { recursive: true, force: true })
    expect(await loadCorpus(dir)).toEqual([])
  })

  // asRecord array-handling safety: a YAML array root IS `typeof "object"`
  // and not null, so a naive `asRecord` would let it through as a "record"
  // and then read `.task_id` / `.objective` off it (undefined) — the task
  // would slip into the loader as a half-formed record. The `!Array.isArray`
  // guard makes an array-root task YAML collapse to "skip" (returns null),
  // so the valid sibling task is the ONLY instance loaded.
  test("(a'') a task YAML whose root is a YAML array is skipped, valid sibling still loads", async () => {
    const cacheDir = join(dir, "cache", "demo")
    await writeSyntheticRealCorpus(dir, cacheDir)
    // Drop a second task file whose top-level document is an array.
    const taskDir = join(dir, "tasks", "repo", "swebench")
    await writeFile(
      join(taskDir, "py.repo.swebench_demo.array.yaml"),
      "- task_id: py.repo.swebench_demo.array\n- objective: { statement: nope }\n",
    )
    const corpus = await loadCorpus(dir)
    // Only the valid object-root task survives; the array-root one is skipped.
    expect(corpus).toHaveLength(1)
    expect((corpus[0] as Instance).id).toBe("py.repo.swebench_demo.001")
  })

  // W1-A audit fix: previous body had `expect(true).toBe(true); return` for
  // the missing-env path — passing without any assertion of intent. We now
  // use `test.skipIf` so the runner surface a real `skipped` count when the
  // optional env is unset, instead of pretending the test ran.
  const benchCorpusEnv = process.env.QUANTA_SWEBENCH_CORPUS_ROOT
  const benchCorpusAvailable = Boolean(benchCorpusEnv && existsSync(benchCorpusEnv))
  test.skipIf(!benchCorpusAvailable)(
    "(b) loadCorpus on the real $QUANTA_SWEBENCH_CORPUS_ROOT (if present)",
    async () => {
      const root = benchCorpusEnv as string
      const corpus = await loadCorpus(root)
      expect(corpus.length).toBeGreaterThanOrEqual(1)
      const first = corpus[0] as Instance
      expect(first.id.length).toBeGreaterThan(0)
      expect(first.problemStatement.length).toBeGreaterThan(0)
      expect(first.testCmd.length).toBeGreaterThan(0)
      expect(existsSync(first.repoPath)).toBe(true)
    },
  )

  test("missing/empty root still → [] (unchanged contract)", async () => {
    expect(await loadCorpus(join(dir, "nope"))).toEqual([])
    expect(await loadCorpus("")).toEqual([])
  })
})

describe("bench-eval: python swebench seam (hermetic)", () => {
  test("(c) availability false → evaluate returns resolved:false, no throw", async () => {
    const probe = async (): Promise<boolean> => false
    const r = await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", { probe })
    expect(r.resolved).toBe(false)
    expect(r.log).toContain("unavailable")
  })

  test("(c') isPythonSwebenchAvailable false when no interpreter imports swebench", async () => {
    const spawn: Spawn = async () => ({ code: 1, stdout: "", stderr: "ModuleNotFoundError" })
    expect(await isPythonSwebenchAvailable({ spawn })).toBe(false)
  })

  test("empty prediction → resolved:false (never invokes the harness)", async () => {
    let spawned = false
    const spawn: Spawn = async () => {
      spawned = true
      return { code: 0, stdout: "", stderr: "" }
    }
    const r = await evaluateWithPythonSwebench(mkInstance(), "   ", { spawn })
    expect(r.resolved).toBe(false)
    expect(spawned).toBe(false)
  })

  test("non-swebench instance → resolved:false (no metadata)", async () => {
    const r = await evaluateWithPythonSwebench(
      mkInstance({}, { noSwebench: true }),
      "diff --git a b",
    )
    expect(r.resolved).toBe(false)
    expect(r.log).toContain("no swebench metadata")
  })

  test("fake harness reports resolved → resolved:true, parsed from report json", async () => {
    const spawn: Spawn = async (argv, cwd) => {
      if (argv.includes("import swebench")) return { code: 0, stdout: "", stderr: "" }
      // Emulate the harness writing its report json into cwd.
      await Bun.write(
        join(cwd, "quanta.run.json"),
        JSON.stringify({ resolved_ids: ["demo__demo-1"] }),
      )
      return { code: 0, stdout: "graded", stderr: "" }
    }
    const r = await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", { spawn })
    expect(r.resolved).toBe(true)
    expect(r.log).toContain("resolved_ids")
  })

  test("fake harness with empty report → resolved:false (caller falls back)", async () => {
    const spawn: Spawn = async (argv, cwd) => {
      if (argv.includes("import swebench")) return { code: 0, stdout: "", stderr: "" }
      await Bun.write(join(cwd, "quanta.run.json"), JSON.stringify({ resolved_ids: [] }))
      return { code: 0, stdout: "", stderr: "" }
    }
    const r = await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", { spawn })
    expect(r.resolved).toBe(false)
  })

  test("defaults --dataset_name to SWE-bench Verified when opts.datasetName unset", async () => {
    expect(SWEBENCH_VERIFIED_DATASET).toBe("princeton-nlp/SWE-bench_Verified")
    let harnessArgv: string[] = []
    const spawn: Spawn = async (argv, cwd) => {
      if (argv.includes("import swebench")) return { code: 0, stdout: "", stderr: "" }
      harnessArgv = argv
      await Bun.write(join(cwd, "quanta.run.json"), JSON.stringify({ resolved_ids: [] }))
      return { code: 0, stdout: "", stderr: "" }
    }
    await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", { spawn })
    const i = harnessArgv.indexOf("--dataset_name")
    expect(i).toBeGreaterThan(-1)
    expect(harnessArgv[i + 1]).toBe("princeton-nlp/SWE-bench_Verified")
  })

  test("explicit opts.datasetName overrides the Verified default", async () => {
    let harnessArgv: string[] = []
    const spawn: Spawn = async (argv, cwd) => {
      if (argv.includes("import swebench")) return { code: 0, stdout: "", stderr: "" }
      harnessArgv = argv
      await Bun.write(join(cwd, "quanta.run.json"), JSON.stringify({ resolved_ids: [] }))
      return { code: 0, stdout: "", stderr: "" }
    }
    await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", {
      spawn,
      datasetName: "princeton-nlp/SWE-bench_Lite",
    })
    const i = harnessArgv.indexOf("--dataset_name")
    expect(harnessArgv[i + 1]).toBe("princeton-nlp/SWE-bench_Lite")
  })

  test("runner falls back to local testCmd when harness unavailable (no throw)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "bench-eval-repo-"))
    try {
      await mkdir(repo, { recursive: true })
      const { runInstance } = await import("../../src/apps/bench/eval")
      const noopLLM = {
        async *stream() {
          yield { type: "text_delta" as const, delta: "noop" }
          yield { type: "message_stop" as const, stop_reason: "end_turn" as const }
        },
      }
      const result = await runInstance(mkInstance({ repoPath: repo, testCmd: "true" }), {
        llm: noopLLM,
        maxTurns: 2,
        timeoutMs: 20000,
        pythonSwebench: { opts: { probe: async () => false } },
      })
      // probe=false ⇒ evaluate returns resolved:false; verify() never throws.
      expect(result.passed).toBe(false)
      expect(typeof result.patch).toBe("string")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("bench-eval: --dry-run plan", () => {
  const insts: Instance[] = [
    mkInstance({ id: "a" }),
    mkInstance({ id: "b" }),
    mkInstance({ id: "c" }),
  ]
  const tasks: SwebenchTask[] = [
    {
      instanceId: "demo__a",
      repo: "demo/a",
      baseCommit: "0".repeat(40),
      problemStatement: "fix a",
      raw: {},
    },
    {
      instanceId: "demo__b",
      repo: "demo/b",
      baseCommit: "1".repeat(40),
      problemStatement: "fix b",
      raw: {},
    },
  ]

  test("(d) buildDryRunPlan shape with a limit", () => {
    const plan = buildDryRunPlan("/corpus", insts, { n: 5, limit: 2, pythonHarness: true })
    expect(plan).toEqual({
      sourceLabel: "corpus",
      sourcePath: "/corpus",
      total: 3,
      selected: 2,
      n: 5,
      limit: 2,
      pythonHarness: true,
      sample: ["a", "b"],
    })
  })

  test("(d') no limit selects all; unset root labelled; lines render", () => {
    const plan = buildDryRunPlan("", insts, { n: 1, limit: null, pythonHarness: false })
    expect(plan.sourcePath).toBe("(unset)")
    expect(plan.selected).toBe(3)
    const lines = formatDryRunPlan(plan)
    expect(lines[0]).toContain("NO LLM will be called")
    expect(lines.join("\n")).toContain("corpus: (unset)")
    expect(lines.join("\n")).toContain("verifier: local testCmd")
    expect(lines.join("\n")).toContain("sample ids: a, b, c")
  })

  test("(d'') dataset plan renders dataset path + instance ids", () => {
    const plan = buildDatasetDryRunPlan("/dataset.jsonl", tasks, {
      n: 2,
      limit: 1,
      pythonHarness: true,
    })
    expect(plan.sourceLabel).toBe("dataset")
    expect(plan.sourcePath).toBe("/dataset.jsonl")
    expect(plan.total).toBe(2)
    expect(plan.selected).toBe(1)
    expect(plan.sample).toEqual(["demo__a"])
    const lines = formatDryRunPlan(plan)
    expect(lines.join("\n")).toContain("dataset: /dataset.jsonl")
    expect(lines.join("\n")).toContain("sample ids: demo__a")
  })

  test("empty corpus → selected 0, sample (none)", () => {
    const lines = formatDryRunPlan(
      buildDryRunPlan("/x", [], { n: 1, limit: null, pythonHarness: false }),
    )
    expect(lines.join("\n")).toContain("0 loaded, 0 selected")
    expect(lines.join("\n")).toContain("sample ids: (none)")
  })
})
