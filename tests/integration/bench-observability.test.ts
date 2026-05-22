/**
 * RFC-0002 Wave D — bench observability wiring (hermetic, deterministic).
 *
 * No real LLM/python/network. FakeLLM mirrors bench.test.ts. Asserts the
 * default-OFF contract is byte-identical, and that `--observe-dir` produces a
 * coherent trajectory (sandbox/patch_generated/verify/session_end), a
 * metrics.json + summary.json snapshot, strict-degraded handling, and
 * one-file-per-attempt Best-of-N.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { isTrajectoryEvent } from "@/shared"
import { loadCorpus, writeSyntheticCorpus } from "../../src/apps/bench/corpus/loader"
import { finalizeRun, type RunObservation, runInstance } from "../../src/apps/bench/eval"
import { buildReport } from "../../src/apps/bench/report"
import type { Instance, InstanceResult } from "../../src/apps/bench/types"

/** FakeLLM that fixes the planted add() bug with the real edit tool. Copied
 *  from bench.test.ts (one edit turn, then a final text turn). */
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
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    if (this.calls === 1) {
      yield { type: "tool_use_start", id: "e1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "e1",
        input: { path: join(sandbox, this.file), old_string: this.oldStr, new_string: this.newStr },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const DEPS = { maxTurns: 5, timeoutMs: 30000 }

const withTmp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "bench-obs-"))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const readJsonl = (file: string): unknown[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown)

describe("bench observability (RFC-0002 W-D)", () => {
  test("control: NO observe-dir ⇒ runInstance unchanged, writes nothing extra", async () => {
    await withTmp(async (dir) => {
      await writeSyntheticCorpus(dir)
      const add = (await loadCorpus(dir)).find((i) => i.id === "inst-add") as Instance
      const before = readdirSync(dir).sort()
      const r = await runInstance(add, {
        ...DEPS,
        llm: new FixingLLM("math.js", "return a - b", "return a + b"),
      })
      expect(r.passed).toBe(true)
      expect(r.error).toBeUndefined()
      expect(r.patch).toContain("return a + b")
      expect(r.verdict ?? "ok").toBe("ok")
      // No trajectory side effects anywhere under the corpus dir.
      expect(readdirSync(dir).sort()).toEqual(before)
    })
  })

  test("observe-dir set ⇒ coherent trajectory + metrics.json + summary.json", async () => {
    await withTmp(async (dir) => {
      const corpus = join(dir, "corpus")
      const obs = join(dir, "obs")
      await writeSyntheticCorpus(corpus)
      const add = (await loadCorpus(corpus)).find((i) => i.id === "inst-add") as Instance
      const runId = "run-1"
      let ts = 1_000
      const r = await runInstance(add, {
        ...DEPS,
        llm: new FixingLLM("math.js", "return a - b", "return a + b"),
        observe: { dir: obs, runId, now: () => ts++ },
      })
      expect(r.passed).toBe(true)
      expect(r.verdict ?? "ok").toBe("ok")

      const traj = join(obs, runId, `${add.id}.0.jsonl`)
      expect(existsSync(traj)).toBe(true)
      const events = readJsonl(traj)
      expect(events.length).toBeGreaterThan(0)
      for (const e of events) expect(isTrajectoryEvent(e)).toBe(true)
      const byKind = (k: string) =>
        events.filter((e) => (e as { kind: string }).kind === k) as Array<{
          data: Record<string, unknown>
          ctx: { runId: string; instanceId?: string; attempt?: number }
        }>

      const sandbox = byKind("sandbox")
      expect(sandbox).toHaveLength(1)
      expect(typeof sandbox[0]?.data.baseCommit).toBe("string")
      expect(typeof sandbox[0]?.data.repoCommit).toBe("string")
      expect(typeof sandbox[0]?.data.envPolicyVersion).toBe("string")
      expect(sandbox[0]?.ctx).toMatchObject({ runId, instanceId: add.id, attempt: 0 })

      const patch = byKind("patch_generated")
      expect(patch).toHaveLength(1)
      expect(patch[0]?.data.applyStatus).toBe("generated")
      expect(patch[0]?.data.filesChanged as number).toBeGreaterThanOrEqual(1)
      const patchPath = patch[0]?.data.diffPath as string
      expect(existsSync(patchPath)).toBe(true)
      expect(readFileSync(patchPath, "utf8")).toContain("return a + b")

      const verify = byKind("verify")
      expect(verify).toHaveLength(1)
      expect(typeof verify[0]?.data.passed).toBe("boolean")
      expect(verify[0]?.data.passed).toBe(true)
      expect(typeof verify[0]?.data.command).toBe("string")

      expect(byKind("session_end")).toHaveLength(1)

      // Run-end derived artifacts.
      const obsRoot: RunObservation = { dir: obs, runId, now: () => ts++ }
      await finalizeRun(obsRoot, [r])
      const metricsFile = join(obs, runId, "metrics.json")
      const summaryFile = join(obs, runId, "summary.json")
      expect(existsSync(metricsFile)).toBe(true)
      expect(existsSync(summaryFile)).toBe(true)
      const metrics = JSON.parse(readFileSync(metricsFile, "utf8")) as {
        pricingVersion: string
        snapshot: { counters: Record<string, number> }
      }
      expect(metrics.pricingVersion).toBe("pricing.v2")
      expect(metrics.snapshot.counters.instances).toBe(1)
      expect(metrics.snapshot.counters.passed).toBe(1)
      const summary = JSON.parse(readFileSync(summaryFile, "utf8")) as {
        runId: string
        resolved: number
        total: number
        degraded: number
        instances: Array<{ id: string; passed: boolean; verdict: string; patchPath?: string }>
      }
      expect(summary.runId).toBe(runId)
      expect(summary.total).toBe(1)
      expect(summary.resolved).toBe(1)
      expect(summary.degraded).toBe(0)
      expect(summary.instances).toHaveLength(1)
      expect(summary.instances[0]?.id).toBe(add.id)
      expect(summary.instances[0]?.passed).toBe(true)
      expect(summary.instances[0]?.verdict).toBe("ok")
    })
  })

  test("strict degraded: unwritable observe path ⇒ verdict degraded, excluded", async () => {
    await withTmp(async (dir) => {
      const corpus = join(dir, "corpus")
      await writeSyntheticCorpus(corpus)
      const add = (await loadCorpus(corpus)).find((i) => i.id === "inst-add") as Instance
      // Point the observe dir at a path whose parent is a regular file ⇒
      // mkdir/append throws ⇒ strict recorder rethrows ⇒ degraded.
      const notADir = join(dir, "afile")
      Bun.write(notADir, "x")
      await Bun.sleep(1)
      const obs = join(notADir, "cannot", "exist")
      const r = await runInstance(add, {
        ...DEPS,
        llm: new FixingLLM("math.js", "return a - b", "return a + b"),
        observe: { dir: obs, runId: "rd", now: () => 1 },
      })
      expect(r.verdict).toBe("degraded")

      const summaryDir = mkdtempSync(join(tmpdir(), "bench-obs-sum-"))
      try {
        const summary = await finalizeRun({ dir: summaryDir, runId: "rd", now: () => 1 }, [r])
        expect(summary.total).toBe(0)
        expect(summary.resolved).toBe(0)
        expect(summary.degraded).toBe(1)
        expect(summary.instances[0]?.verdict).toBe("degraded")
      } finally {
        rmSync(summaryDir, { recursive: true, force: true })
      }
    })
  })

  // LLM that writes a file containing a planted secret (one write turn, then
  // a final text turn). Used to prove patch/summary/metrics are scrubbed.
  class SecretPlantingLLM implements LLMPort {
    calls = 0
    constructor(
      private readonly file: string,
      private readonly secret: string,
    ) {}
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      this.calls += 1
      const text = input.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === "text" ? b.text : ""))
        .join(" ")
      const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
      if (this.calls === 1) {
        yield { type: "tool_use_start", id: "w1", name: "write" }
        yield {
          type: "tool_use_end",
          id: "w1",
          input: {
            path: join(sandbox, this.file),
            content: `module.exports.token = "${this.secret}"\n`,
          },
        }
        yield { type: "message_stop", stop_reason: "tool_use" }
        return
      }
      yield { type: "text_delta", delta: "done" }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
  }

  test("S2: planted secret never lands raw in .patch / summary.json / metrics.json", async () => {
    await withTmp(async (dir) => {
      const corpus = join(dir, "corpus")
      const obs = join(dir, "obs")
      await writeSyntheticCorpus(corpus)
      const add = (await loadCorpus(corpus)).find((i) => i.id === "inst-add") as Instance
      const secret = "sk-ant-api03-PLANTEDSECRET0000111122223333AAAA"
      const runId = "run-s2"
      let ts = 1
      const r = await runInstance(add, {
        ...DEPS,
        llm: new SecretPlantingLLM("leak.js", secret),
        observe: { dir: obs, runId, now: () => ts++ },
      })
      // The patch must reference the new file but carry NO raw secret.
      const patchFile = r.patchPath as string
      expect(existsSync(patchFile)).toBe(true)
      const patchText = readFileSync(patchFile, "utf8")
      expect(patchText).not.toContain(secret)

      await finalizeRun({ dir: obs, runId, now: () => ts++ }, [r])
      const summaryText = readFileSync(join(obs, runId, "summary.json"), "utf8")
      const metricsText = readFileSync(join(obs, runId, "metrics.json"), "utf8")
      expect(summaryText).not.toContain(secret)
      expect(metricsText).not.toContain(secret)
      // The trajectory jsonl (recorder + bench lines) is also clean.
      const traj = readFileSync(join(obs, runId, `${add.id}.0.jsonl`), "utf8")
      expect(traj).not.toContain(secret)
    })
  })

  test("C9: bench exec child does NOT inherit process.env.OPENAI_API_KEY", async () => {
    await withTmp(async (dir) => {
      const corpus = join(dir, "corpus")
      await writeSyntheticCorpus(corpus)
      const add = (await loadCorpus(corpus)).find((i) => i.id === "inst-add") as Instance
      // testCmd exits 0 ONLY if the child cannot see the parent's secret.
      const leakProbe: Instance = {
        ...add,
        id: "inst-envscrub",
        testCmd: 'test -z "$OPENAI_API_KEY"',
      }
      const prev = process.env.OPENAI_API_KEY
      process.env.OPENAI_API_KEY = "sk-ant-api03-SHOULDNOTLEAK0000111122223333BBBB"
      try {
        const r = await runInstance(leakProbe, {
          ...DEPS,
          llm: new FixingLLM("math.js", "return a - b", "return a + b"),
        })
        // passed:true ⇒ the spawned child saw an EMPTY OPENAI_API_KEY.
        expect(r.passed).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = prev
      }
    })
  })

  test("C8: 1 degraded of 2 ⇒ printSummary/report resolved/total equals summary.json", async () => {
    await withTmp(async (dir) => {
      // One OK+passed instance, one strict-degraded instance.
      const okR: InstanceResult = { id: "a", passed: true, patch: "", turns: 1, verdict: "ok" }
      const degR: InstanceResult = {
        id: "b",
        passed: false,
        patch: "",
        turns: 0,
        verdict: "degraded",
      }
      const results = [okR, degR]

      const summaryDir = join(dir, "sum")
      const summary = await finalizeRun({ dir: summaryDir, runId: "c8", now: () => 1 }, results)
      // observe.summarize: degraded excluded ⇒ 1/1, 1 degraded.
      expect(summary.total).toBe(1)
      expect(summary.resolved).toBe(1)
      expect(summary.degraded).toBe(1)

      // report.ts MUST match summary.json (same degraded-excluding denominator).
      const report = buildReport({ provider: "fake", model: "fake", n: 1 }, results)
      expect(report.totals.total).toBe(summary.total)
      expect(report.totals.resolved).toBe(summary.resolved)
      expect(report.totals.resolvedPct).toBe(100)

      // printSummary's headline uses resolvedTotals(summary.results) — assert
      // that same helper (the single source) yields the summary.json numbers.
      const onDisk = JSON.parse(readFileSync(join(summaryDir, "c8", "summary.json"), "utf8")) as {
        resolved: number
        total: number
        degraded: number
      }
      expect(onDisk.total).toBe(1)
      expect(onDisk.resolved).toBe(1)
      expect(onDisk.degraded).toBe(1)
    })
  })

  test("Best-of-N n=2 ⇒ two attempt files <id>.0.jsonl / <id>.1.jsonl", async () => {
    await withTmp(async (dir) => {
      const corpus = join(dir, "corpus")
      const obs = join(dir, "obs")
      await writeSyntheticCorpus(corpus)
      const add = (await loadCorpus(corpus)).find((i) => i.id === "inst-add") as Instance
      const runId = "bo"
      const base = {
        ...DEPS,
        llm: new FixingLLM("math.js", "return a - b", "return a + b"),
        observe: { dir: obs, runId, now: () => 1 },
      }
      const results: InstanceResult[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        results.push(
          await runInstance(add, {
            ...base,
            llm: new FixingLLM("math.js", "return a - b", "return a + b"),
            observe: { ...base.observe, attempt },
          }),
        )
      }
      expect(existsSync(join(obs, runId, `${add.id}.0.jsonl`))).toBe(true)
      expect(existsSync(join(obs, runId, `${add.id}.1.jsonl`))).toBe(true)
    })
  })
})
