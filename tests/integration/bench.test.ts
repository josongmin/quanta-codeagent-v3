import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  type Prediction,
  parseSwebenchJsonl,
  writePredictions,
} from "../../src/apps/bench/corpus/dataset"
import { loadCorpus, writeSyntheticCorpus } from "../../src/apps/bench/corpus/loader"
import { runInstance } from "../../src/apps/bench/eval"
import type { Instance } from "../../src/apps/bench/types"

/**
 * FakeLLM that fixes a planted bug with the REAL edit tool. It extracts the
 * sandbox dir from the prompt the runner injects ("Work inside <dir>.") so it
 * can issue an absolute edit path (storage resolves against process.cwd(),
 * which is not the sandbox). One scripted assistant turn: edit, then a final
 * text turn so the loop completes. Pattern copied from agent-loop.test.ts.
 */
class FixingLLM implements LLMPort {
  calls = 0
  constructor(
    private readonly file: string,
    private readonly oldStr: string,
    private readonly newStr: string,
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const m = text.match(/Work inside (\S+?)\./)
    const sandbox = m?.[1] ?? ""
    if (this.calls === 1) {
      const path = join(sandbox, this.file)
      yield { type: "tool_use_start", id: "e1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "e1",
        input: { path, old_string: this.oldStr, new_string: this.newStr },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** FakeLLM that does nothing: one text turn, no tool calls → no fix. */
class NoopLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "I will not change anything" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Flaky LLM: fails the first `failCount` attempts (noop), then fixes. Each
 *  runInstance call is an independent attempt → tracked via a shared counter. */
class FlakyLLM implements LLMPort {
  private attempt = 0
  private callsInAttempt = 0
  constructor(
    private readonly failCount: number,
    private readonly file: string,
    private readonly oldStr: string,
    private readonly newStr: string,
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (this.callsInAttempt === 0) this.attempt += 1
    this.callsInAttempt += 1
    const shouldFix = this.attempt > this.failCount
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    if (shouldFix && this.callsInAttempt === 1) {
      yield { type: "tool_use_start", id: "f1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "f1",
        input: {
          path: join(sandbox, this.file),
          old_string: this.oldStr,
          new_string: this.newStr,
        },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      this.callsInAttempt = 0
      return
    }
    this.callsInAttempt = 0
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const DEPS = { maxTurns: 5, timeoutMs: 30000 }

describe("bench integration", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-test-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("writeSyntheticCorpus → loadCorpus returns 2 instances", async () => {
    await writeSyntheticCorpus(dir)
    const corpus = await loadCorpus(dir)
    expect(corpus).toHaveLength(2)
    const ids = corpus.map((i) => i.id).sort()
    expect(ids).toEqual(["inst-add", "inst-greet"])
    for (const inst of corpus) {
      expect(inst.problemStatement.length).toBeGreaterThan(0)
      expect(inst.testCmd.length).toBeGreaterThan(0)
    }
  })

  test("loadCorpus on missing/empty root returns [] (never throws)", async () => {
    expect(await loadCorpus(join(dir, "does-not-exist"))).toEqual([])
    expect(await loadCorpus("")).toEqual([])
    expect(await loadCorpus(dir)).toEqual([]) // empty dir
  })

  test("runInstance with a correct-edit FakeLLM → passed:true, non-empty patch", async () => {
    await writeSyntheticCorpus(dir)
    const corpus = await loadCorpus(dir)
    const add = corpus.find((i) => i.id === "inst-add") as Instance
    const llm = new FixingLLM("math.js", "return a - b", "return a + b")
    const result = await runInstance(add, { ...DEPS, llm })
    expect(result.passed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.patch.length).toBeGreaterThan(0)
    expect(result.patch).toContain("return a + b")
  })

  test("runInstance with a do-nothing FakeLLM → passed:false", async () => {
    await writeSyntheticCorpus(dir)
    const corpus = await loadCorpus(dir)
    const greet = corpus.find((i) => i.id === "inst-greet") as Instance
    const result = await runInstance(greet, { ...DEPS, llm: new NoopLLM() })
    expect(result.passed).toBe(false)
  })

  test("Best-of-N n=3 over a flaky LLM (2 fail, 1 pass) → overall passed", async () => {
    await writeSyntheticCorpus(dir)
    const corpus = await loadCorpus(dir)
    const add = corpus.find((i) => i.id === "inst-add") as Instance
    const { sampleBestOfN } = await import("../../src/apps/bench/sampler")
    const llm = new FlakyLLM(2, "math.js", "return a - b", "return a + b")
    const out = await sampleBestOfN({
      n: 3,
      concurrency: 1, // serialize so the flaky counter is deterministic
      makeAttempt: () => runInstance(add, { ...DEPS, llm }),
      score: (r) => (r.passed ? 1 : 0),
    })
    expect(out.attempts).toHaveLength(3)
    expect(out.best.value?.passed).toBe(true)
    const passes = out.attempts.filter((a) => a.value?.passed).length
    expect(passes).toBe(1)
  })
})

// =========================================================================
// Hell-cases — adversarial scenarios that lock down failure modes the bench
// harness must survive. Each test gets its OWN tmp dir / predictions file so
// they are fully isolated and can run in parallel.
// =========================================================================

const RUN_INSTANCE_TIMEOUT_MS = 30_000
const IS_WIN = process.platform === "win32"

/** Build a tiny instance with one file, planted bug, local testCmd — no
 *  swebench metadata (so no repair/verify-guard gating is involved). */
const makeMiniInstance = (dir: string, id: string): Instance => {
  const repo = join(dir, `repo-${id}`)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, "math.js"), "function add(a,b){return a-b}\nmodule.exports={add}\n")
  return {
    id,
    repoPath: repo,
    problemStatement: `Fix add() in math.js.`,
    testCmd: `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`,
  }
}

/** LLM that throws on stream() — used to drive runInstance into its catch
 *  arm and verify that sandbox cleanup still happens. */
class ThrowingLLM implements LLMPort {
  // biome-ignore lint/correctness/useYield: intentionally throw before yielding.
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("intentional LLM failure")
  }
}

/** LLM that emits a noop end_turn — used as a fast, deterministic instance
 *  driver when we don't care whether the agent actually fixes the bug. */
class NoopEndLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

// -------------------------------------------------------------------------
// HC-A. Instance failure cascade — 5 instances, one fails, others complete.
// -------------------------------------------------------------------------

describe("HC-A. instance failure cascade", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-hc-a-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test(
    "5 instances run sequentially; instance 2's LLM throws mid-run; cascade does NOT halt",
    async () => {
      const instances: Instance[] = []
      for (let i = 0; i < 5; i++) instances.push(makeMiniInstance(dir, `inst-${i}`))

      // The "instance 2 fails" mechanism: a per-instance throwing LLM. The
      // agent loop has internal retry/PTL handling, so a stream-throw alone
      // doesn't always surface as InstanceResult.error — but the BATCH-LEVEL
      // contract we pin is: every instance still produces a row, the loop
      // never aborts the cascade, and no throw escapes runInstance.
      const results = []
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i] as Instance
        const llm = i === 2 ? new ThrowingLLM() : new NoopEndLLM()
        const r = await runInstance(inst, { ...DEPS, llm })
        results.push(r)
      }
      // Every instance produced a result — no throw escaped runInstance.
      expect(results).toHaveLength(5)
      // All ids preserved in order — proves the cascade didn't halt or skip.
      expect(results.map((r) => r.id)).toEqual(["inst-0", "inst-1", "inst-2", "inst-3", "inst-4"])
      // None of them passed (NoopEndLLM does no fix; ThrowingLLM yields a
      // failed/empty trajectory).
      for (const r of results) expect(r.passed).toBe(false)
      // Each result has a numeric turns field — even the failing one.
      for (const r of results) expect(typeof r.turns).toBe("number")
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test(
    "empty problemStatement: runInstance still produces a result (does NOT skip silently)",
    async () => {
      const inst = makeMiniInstance(dir, "empty-problem")
      const empty: Instance = { ...inst, problemStatement: "" }
      const r = await runInstance(empty, { ...DEPS, llm: new NoopEndLLM() })
      // Pinned behavior: bench does NOT pre-validate problem text; it hands
      // the empty string to the agent and grades the (necessarily failing)
      // sandbox. The contract here is "no skip-silently": a result MUST be
      // produced, with a stable id. (No `error` because the LLM didn't throw.)
      expect(r.id).toBe("empty-problem")
      expect(r.passed).toBe(false)
      expect(typeof r.turns).toBe("number")
      // TODO(follow-up): consider rejecting empty problemStatement upstream
      // (validator at swebench-dataset.toTask level) so a torn dataset row
      // doesn't burn agent turns producing nothing. Currently it is accepted.
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test.skipIf(IS_WIN)(
    "instance whose repoPath becomes unreadable: runInstance returns a result with error, no crash",
    async () => {
      const inst = makeMiniInstance(dir, "perms")
      // Make the source repo 000 → cp -r in the runner will fail.
      // CRITICAL: restore perms BEFORE afterEach tries to rm.
      await chmod(inst.repoPath, 0o000)
      let r: { passed: boolean; error?: string } | undefined
      try {
        const out = await runInstance(inst, { ...DEPS, llm: new NoopEndLLM() })
        r = { passed: out.passed, ...(out.error !== undefined ? { error: out.error } : {}) }
      } finally {
        await chmod(inst.repoPath, 0o755)
      }
      expect(r).toBeDefined()
      expect(r?.passed).toBe(false)
      // The runInstance catch arm surfaces the cp error via InstanceResult.error.
      expect(r?.error).toBeDefined()
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )
})

// -------------------------------------------------------------------------
// HC-B. Predictions.jsonl integrity.
// -------------------------------------------------------------------------

describe("HC-B. predictions.jsonl integrity", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-hc-b-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("writePredictions atomicity: the file is either complete or empty, never a torn JSONL line", async () => {
    const file = join(dir, "predictions.jsonl")
    const rows: Prediction[] = []
    for (let i = 0; i < 50; i++) {
      rows.push({
        instance_id: `inst-${i}`,
        model_name_or_path: "fake-model",
        model_patch: `diff --git a/f${i} b/f${i}\n@@ -1 +1 @@\n-old\n+new\n`,
      })
    }
    await writePredictions(file, rows)
    const body = readFileSync(file, "utf8")
    // Every non-empty line MUST parse as valid JSON (no torn line).
    const lines = body.split("\n").filter((l) => l !== "")
    expect(lines.length).toBe(50)
    for (const l of lines) {
      const parsed = JSON.parse(l) as Prediction
      expect(parsed.instance_id).toMatch(/^inst-\d+$/)
      expect(typeof parsed.model_patch).toBe("string")
    }
  })

  test("re-running writePredictions overwrites cleanly: no leftover lines from prior run", async () => {
    const file = join(dir, "predictions.jsonl")
    // First write: 5 rows.
    const first: Prediction[] = Array.from({ length: 5 }, (_, i) => ({
      instance_id: `first-${i}`,
      model_name_or_path: "m",
      model_patch: "p",
    }))
    await writePredictions(file, first)
    const beforeLen = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "").length
    expect(beforeLen).toBe(5)
    // Second write: 2 rows — MUST replace (not append to) the prior file.
    const second: Prediction[] = Array.from({ length: 2 }, (_, i) => ({
      instance_id: `second-${i}`,
      model_name_or_path: "m",
      model_patch: "p",
    }))
    await writePredictions(file, second)
    const after = readFileSync(file, "utf8")
    const lines = after.split("\n").filter((l) => l !== "")
    expect(lines.length).toBe(2)
    for (const l of lines) {
      const parsed = JSON.parse(l) as Prediction
      expect(parsed.instance_id).toMatch(/^second-\d$/)
    }
    // No "first-N" leakage.
    expect(after).not.toContain("first-")
  })
})

// -------------------------------------------------------------------------
// HC-C. Sandbox cleanup.
// -------------------------------------------------------------------------

describe("HC-C. sandbox cleanup", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-hc-c-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Count live `bench-*` tmpdirs (sandbox-leak telltale). The runner names
   *  its sandbox `bench-<id>-<rand>`; if cleanup misses, we'd see them
   *  accumulate after each call. */
  const countBenchTmps = (): number =>
    readdirSync(tmpdir()).filter((n) => n.startsWith("bench-")).length

  test(
    "LLM throws mid-run → sandbox tmp dir is cleaned via finally",
    async () => {
      const inst = makeMiniInstance(dir, "throw-cleanup")
      const before = countBenchTmps()
      const r = await runInstance(inst, { ...DEPS, llm: new ThrowingLLM() })
      // Result is returned (no throw escape). The agent loop has internal
      // retry/PTL handling that may swallow the LLM throw into a max-turns
      // exhaustion verdict; the CONTRACT we pin is "no throw escape + sandbox
      // cleanup", not the shape of the error field.
      expect(r.passed).toBe(false)
      // Sandbox tmp dirs MUST have been cleaned up via the runInstance finally.
      const after = countBenchTmps()
      expect(after).toBeLessThanOrEqual(before)
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test("50 sequential bench instances → no tmp-dir accumulation", async () => {
    const inst = makeMiniInstance(dir, "no-accum")
    const before = countBenchTmps()
    // Use NoopEndLLM (deterministic, no real agent loop overhead).
    const llm = new NoopEndLLM()
    for (let i = 0; i < 50; i++) {
      const r = await runInstance(inst, { ...DEPS, llm })
      expect(r.id).toBe("no-accum")
    }
    const after = countBenchTmps()
    // Allow a small slack (a concurrent process might create one) — pin the
    // strong invariant: NO net growth from 50 successive runs.
    expect(after - before).toBeLessThanOrEqual(2)
  }, 60_000) // 50 instances × ~150ms each on cold spawn = 7-10s; leave headroom.
})

// -------------------------------------------------------------------------
// HC-D. Adversarial fixture inputs.
// -------------------------------------------------------------------------

describe("HC-D. adversarial fixtures", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-hc-d-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("absurdly long FAIL_TO_PASS in raw row: parseSwebenchJsonl handles it, ignores the field", () => {
    // FAIL_TO_PASS is one of the no-leak forbidden fields; the parser keeps it
    // only on `raw` (untouched). 1000 entries — adversarial but valid JSON.
    const failToPass = Array.from({ length: 1000 }, (_, i) => `tests/test_${i}::test_thing`)
    const line = JSON.stringify({
      instance_id: "huge-task",
      repo: "org/repo",
      base_commit: "abc123",
      problem_statement: "fix something",
      FAIL_TO_PASS: failToPass,
    })
    const tasks = parseSwebenchJsonl(line)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.instanceId).toBe("huge-task")
    // The forbidden field is preserved on `raw` (parseSwebenchJsonl is a
    // tolerant reader, not a sanitizer). The no-leak invariant is enforced
    // downstream — `toInstance` does NOT propagate FAIL_TO_PASS into the
    // Instance shape, and the seed-message seam uses validator.failTail only.
    const raw = tasks[0]?.raw ?? {}
    expect(Array.isArray(raw.FAIL_TO_PASS)).toBe(true)
    expect((raw.FAIL_TO_PASS as string[]).length).toBe(1000)
  })

  test(
    "instance with a binary file in the repo: runInstance doesn't blow up reading it",
    async () => {
      const inst = makeMiniInstance(dir, "binary-file")
      // Drop a binary blob: 4KB of random-ish non-printable bytes.
      const blob = Buffer.alloc(4096)
      for (let i = 0; i < blob.length; i++) blob[i] = (i * 7) & 0xff
      writeFileSync(join(inst.repoPath, "data.bin"), blob)
      // Drive a REAL text edit so the snapshot `git add -A` + `git diff
      // --cached` traverses a sandbox containing BOTH a binary blob and an
      // edited text file. This is the robustness contract under test: the
      // diff/scan path must process the non-UTF-8 blob without throwing and
      // still emit a clean unified diff for the text change. (Using a no-op
      // LLM would instead trip the fail-closed empty-prediction guard in
      // `verdict.ts`, which sets `error` for ANY empty patch — binary or not —
      // and so would not exercise the binary-diff path at all.)
      const llm = new FixingLLM("math.js", "return a-b", "return a+b")
      const r = await runInstance(inst, { ...DEPS, llm })
      expect(r.id).toBe("binary-file")
      expect(typeof r.patch).toBe("string")
      // git emits "Binary files .. differ" (or omits unchanged binaries) and
      // a normal text hunk for math.js — never a thrown read error. The patch
      // carries the text edit and NO error surfaces (non-empty prediction).
      expect(r.patch).toContain("return a+b")
      expect(r.error).toBeUndefined()
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )
})

// -------------------------------------------------------------------------
// HC-E. Concurrency.
// -------------------------------------------------------------------------

describe("HC-E. concurrency", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-hc-e-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("two parallel writePredictions to DIFFERENT files (different runIds) — both complete cleanly, no collision", async () => {
    const fileA = join(dir, "predictions-runA.jsonl")
    const fileB = join(dir, "predictions-runB.jsonl")
    const rowsA: Prediction[] = Array.from({ length: 20 }, (_, i) => ({
      instance_id: `A-${i}`,
      model_name_or_path: "modelA",
      model_patch: `patchA-${i}`,
    }))
    const rowsB: Prediction[] = Array.from({ length: 20 }, (_, i) => ({
      instance_id: `B-${i}`,
      model_name_or_path: "modelB",
      model_patch: `patchB-${i}`,
    }))
    await Promise.all([writePredictions(fileA, rowsA), writePredictions(fileB, rowsB)])
    const lineCountA = readFileSync(fileA, "utf8")
      .split("\n")
      .filter((l) => l !== "").length
    const lineCountB = readFileSync(fileB, "utf8")
      .split("\n")
      .filter((l) => l !== "").length
    expect(lineCountA).toBe(20)
    expect(lineCountB).toBe(20)
    // Each line is a valid JSON object whose instance_id belongs to its run.
    for (const l of readFileSync(fileA, "utf8")
      .split("\n")
      .filter((l) => l !== "")) {
      const p = JSON.parse(l) as Prediction
      expect(p.instance_id.startsWith("A-")).toBe(true)
    }
    for (const l of readFileSync(fileB, "utf8")
      .split("\n")
      .filter((l) => l !== "")) {
      const p = JSON.parse(l) as Prediction
      expect(p.instance_id.startsWith("B-")).toBe(true)
    }
  })
})
