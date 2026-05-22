/**
 * RFC may-22-unified-agent-runtime / Phase 4+ — batch mode-preset runner
 * contract.
 *
 * Pins the contract:
 *   1. `runMode` rejects a non-"batch" req.mode.
 *   2. Missing `req.batch.corpus` throws.
 *   3. With `seams.loadCorpus` + `seams.runInstance`, runMode iterates EACH
 *      instance through the stub driver and aggregates verdicts.
 *   4. Exit code: 0 iff all instances passed (no failures, no degraded).
 *   5. Optional id-substring filter selects a subset BEFORE limit slice.
 *   6. Test is hermetic — no real bench driver, no real LLM, no fs writes.
 */
import { describe, expect, test } from "bun:test"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { runMode } from "@/../src/apps/agent/mode-presets/batch"
import type { Instance, InstanceResult } from "@/../src/apps/bench/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

const fakeLlm: LLMPort = { model: "test", stream: async function* () {} } as unknown as LLMPort
const recordingStream: StreamPort = { emit: () => undefined }

const inst = (id: string): Instance => ({
  id,
  repoPath: `/tmp/${id}`,
  problemStatement: `fix ${id}`,
  testCmd: "true",
})

const okResult = (id: string): InstanceResult => ({ id, passed: true, patch: "", turns: 1 })
const failResult = (id: string): InstanceResult => ({ id, passed: false, patch: "", turns: 1 })

const baseReq = (over: Partial<AssembleRequest> = {}): AssembleRequest => ({
  mode: "batch",
  base: {
    llm: fakeLlm,
    registry: new ToolRegistry(defaultTools),
    stream: recordingStream,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
  },
  batch: { corpus: "/synthetic/corpus" },
  ...over,
})

describe("batch.runMode — guard", () => {
  test("rejects a wrong req.mode", async () => {
    const req = { ...baseReq(), mode: "headless" as const }
    await expect(runMode(req)).rejects.toThrow(/req.mode must be "batch"/)
  })

  test("rejects a missing corpus", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately stripping a required field for the negative test.
    const req = { ...baseReq(), batch: undefined } as any
    await expect(runMode(req)).rejects.toThrow(/req.batch.corpus is required/)
  })
})

describe("batch.runMode — iteration + aggregation", () => {
  test("iterates every instance through stub runInstance", async () => {
    const calls: string[] = []
    const seams = {
      loadCorpus: async () => [inst("a"), inst("b"), inst("c")] as unknown[],
      runInstance: async (i: unknown) => {
        const ii = i as Instance
        calls.push(ii.id)
        return okResult(ii.id) as unknown
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(calls).toEqual(["a", "b", "c"])
    expect(out.exitCode).toBe(0)
  })

  test("exit code = 1 when ANY instance fails", async () => {
    const seams = {
      loadCorpus: async () => [inst("a"), inst("b")] as unknown[],
      runInstance: async (i: unknown) => {
        const ii = i as Instance
        return (ii.id === "b" ? failResult(ii.id) : okResult(ii.id)) as unknown
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(1)
  })

  test("exit code = 1 when an instance has verdict=degraded", async () => {
    const seams = {
      loadCorpus: async () => [inst("a")] as unknown[],
      runInstance: async () => {
        const r: InstanceResult = {
          id: "a",
          passed: true,
          patch: "",
          turns: 1,
          verdict: "degraded",
        }
        return r as unknown
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(1)
  })

  test("empty corpus returns exitCode 0 (no-op)", async () => {
    const seams = {
      loadCorpus: async () => [] as unknown[],
      runInstance: async () => okResult("x") as unknown,
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(0)
  })
})

describe("batch.runMode — id-substring filter + limit", () => {
  test("filters by req.batch.instance substring", async () => {
    const calls: string[] = []
    const seams = {
      loadCorpus: async () => [inst("django-1"), inst("flask-2"), inst("django-3")] as unknown[],
      runInstance: async (i: unknown) => {
        calls.push((i as Instance).id)
        return okResult((i as Instance).id) as unknown
      },
    }
    await runMode(baseReq({ seams, batch: { corpus: "/c", instance: "django" } }))
    expect(calls).toEqual(["django-1", "django-3"])
  })

  test("limit slice caps the iteration", async () => {
    const calls: string[] = []
    const seams = {
      loadCorpus: async () => [inst("a"), inst("b"), inst("c"), inst("d")] as unknown[],
      runInstance: async (i: unknown) => {
        calls.push((i as Instance).id)
        return okResult((i as Instance).id) as unknown
      },
    }
    await runMode(baseReq({ seams, batch: { corpus: "/c", limit: 2 } }))
    expect(calls).toEqual(["a", "b"])
  })
})
