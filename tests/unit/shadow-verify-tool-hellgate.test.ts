/** ADR-0400 — `shadow_verify` LLM tool hellgate.
 *
 *  Each adversarial case below pins one invariant from the ADR contract:
 *
 *    HELL-SVT-01  tier-1 builder absent port ⇒ tool NOT registered (default-OFF,
 *                 byte-identical to legacy registry).
 *    HELL-SVT-02  tier-1 builder with port ⇒ exactly one tool, name "shadow_verify".
 *    HELL-SVT-03  tool registers as read-only (host workspace is never written).
 *    HELL-SVT-04  tool registers as non-concurrency-safe (worktree race avoidance).
 *    HELL-SVT-05  tool's HITL tier is `pre-approval-ok` (read-only against host).
 *    HELL-SVT-06  zod schema rejects empty patch + empty checks array.
 *    HELL-SVT-07  execute() yields a `progress` event before the result.
 *    HELL-SVT-08  execute() forwards `test_target` to the port verbatim.
 *    HELL-SVT-09  pre-aborted signal ⇒ "aborted before start" + ok:false,
 *                 port is NEVER consulted.
 *    HELL-SVT-10  rendered output prints `applied:` then `ok:` then one line
 *                 per diagnostic in result order; "no diagnostics" trailer
 *                 when empty.
 *    HELL-SVT-11  rendered diagnostic format = `file:line[:col] [severity]
 *                 message (source)` verbatim.
 *    HELL-SVT-12  tool result `ok` mirrors `ShadowVerifyResult.ok`.
 */

import { describe, expect, test } from "bun:test"
import { buildShadowVerifyBlock } from "@/agent/tier1"
import type { AgentConfig } from "@/agent/types"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import {
  formatShadowDiagnostic,
  renderShadowVerifyResult,
  type ShadowDiagnosticMirror,
  type ShadowVerifyPortMirror,
  type ShadowVerifyResultMirror,
  shadowVerifyTool,
} from "@/tool/shadow-verify"

const minimalAgentConfig = (over?: Partial<AgentConfig>): AgentConfig =>
  ({
    // The builder only reads `shadowVerify`; every other slot is irrelevant
    // and a permissive structural cast keeps the test focused.
    shadowVerify: over?.shadowVerify,
  }) as AgentConfig

const fakePort = (
  result: ShadowVerifyResultMirror,
): {
  port: ShadowVerifyPortMirror
  calls: Array<{
    patch: string
    checks: readonly string[]
    testTarget: string | undefined
    signal: AbortSignal | undefined
  }>
} => {
  const calls: Array<{
    patch: string
    checks: readonly string[]
    testTarget: string | undefined
    signal: AbortSignal | undefined
  }> = []
  return {
    calls,
    port: {
      async verify(req, signal) {
        calls.push({
          patch: req.patch,
          checks: req.checks,
          testTarget: req.testTarget,
          signal,
        })
        return result
      },
    },
  }
}

const collect = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const e of tool.execute(input, ctx)) out.push(e)
  return out
}

const makeCtx = (signal?: AbortSignal): ToolContext =>
  ({
    cwd: "/tmp",
    signal: signal ?? new AbortController().signal,
  }) as ToolContext

// ─── HELL-SVT-01/02 ────────────────────────────────────────────────────────

describe("tier-1 builder registration (HELL-SVT-01/02)", () => {
  test("absent port ⇒ empty array (default-OFF)", () => {
    const tools = buildShadowVerifyBlock(minimalAgentConfig())
    expect(tools).toEqual([])
  })

  test("present port ⇒ exactly one tool, name shadow_verify", () => {
    const { port } = fakePort({ ok: true, applied: true, diagnostics: [] })
    // Cast through unknown so the mirror's structural superset assigns into
    // the producer slot. exactOptionalPropertyTypes wants the value typed
    // exactly as the producer port (not `Mirror | undefined`).
    const cfg = { shadowVerify: port as unknown as AgentConfig["shadowVerify"] } as AgentConfig
    const tools = buildShadowVerifyBlock(cfg)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe("shadow_verify")
  })
})

// ─── HELL-SVT-03/04/05 ─────────────────────────────────────────────────────

describe("tool posture (HELL-SVT-03/04/05)", () => {
  const { port } = fakePort({ ok: true, applied: true, diagnostics: [] })
  const tool = shadowVerifyTool(port)

  test("read-only", () => {
    expect(tool.isReadOnly()).toBe(true)
  })

  test("not concurrency-safe", () => {
    expect(tool.isConcurrencySafe({} as never)).toBe(false)
  })

  test("HITL tier is pre-approval-ok", () => {
    expect(tool.hitlTier?.({} as never)).toBe("pre-approval-ok")
  })
})

// ─── HELL-SVT-06 ───────────────────────────────────────────────────────────

describe("input schema validation (HELL-SVT-06)", () => {
  const { port } = fakePort({ ok: true, applied: true, diagnostics: [] })
  const tool = shadowVerifyTool(port)

  test("empty patch ⇒ invalid input result, port NOT called", async () => {
    const calls: number[] = []
    const probe: ShadowVerifyPortMirror = {
      async verify() {
        calls.push(1)
        return { ok: true, applied: true, diagnostics: [] }
      },
    }
    const t = shadowVerifyTool(probe)
    const events = await collect(t as Tool, { patch: "", checks: ["lint"] }, makeCtx())
    const last = events.at(-1)
    expect(last?.type).toBe("result")
    expect(calls).toEqual([])
  })

  test("empty checks ⇒ invalid input result, port NOT called", async () => {
    const calls: number[] = []
    const probe: ShadowVerifyPortMirror = {
      async verify() {
        calls.push(1)
        return { ok: true, applied: true, diagnostics: [] }
      },
    }
    const t = shadowVerifyTool(probe)
    const events = await collect(t as Tool, { patch: "*** Begin Patch", checks: [] }, makeCtx())
    const last = events.at(-1)
    expect(last?.type).toBe("result")
    expect(calls).toEqual([])
  })

  // Reference the unused `tool` to satisfy linter while keeping the parallel
  // pattern with the posture suite.
  test("tool is registrable", () => {
    expect(typeof tool.execute).toBe("function")
  })
})

// ─── HELL-SVT-07 / HELL-SVT-08 / HELL-SVT-12 ───────────────────────────────

describe("execute happy path (HELL-SVT-07/08/12)", () => {
  test("emits progress before result; forwards testTarget; ok mirrors port", async () => {
    const result: ShadowVerifyResultMirror = {
      ok: true,
      applied: true,
      diagnostics: [],
    }
    const { port, calls } = fakePort(result)
    const tool = shadowVerifyTool(port)
    const events = await collect(
      tool as Tool,
      {
        patch: "*** Begin Patch\n*** End Patch\n",
        checks: ["lint", "test"],
        test_target: "tests/unit/shadow-verify-hellgate.test.ts",
      },
      makeCtx(),
    )
    expect(events[0]?.type).toBe("progress")
    const last = events.at(-1)
    expect(last?.type).toBe("result")
    if (last?.type === "result") {
      expect(last.result.ok).toBe(true)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.testTarget).toBe("tests/unit/shadow-verify-hellgate.test.ts")
    expect(calls[0]?.checks).toEqual(["lint", "test"])
  })

  test("ok mirrors a failing port result", async () => {
    const result: ShadowVerifyResultMirror = {
      ok: false,
      applied: true,
      diagnostics: [
        { file: "a.ts", line: 3, severity: "error", message: "boom", source: "typecheck" },
      ],
    }
    const { port } = fakePort(result)
    const tool = shadowVerifyTool(port)
    const events = await collect(
      tool as Tool,
      { patch: "*** Begin Patch\n*** End Patch\n", checks: ["typecheck"] },
      makeCtx(),
    )
    const last = events.at(-1)
    if (last?.type === "result") {
      expect(last.result.ok).toBe(false)
      expect(last.result.output).toContain("applied: yes")
      expect(last.result.output).toContain("ok: no")
      expect(last.result.output).toContain("a.ts:3")
    } else {
      throw new Error("expected result event")
    }
  })
})

// ─── HELL-SVT-09 ───────────────────────────────────────────────────────────

describe("pre-aborted signal (HELL-SVT-09)", () => {
  test("aborted before start ⇒ result short-circuits, port NEVER called", async () => {
    const calls: number[] = []
    const port: ShadowVerifyPortMirror = {
      async verify() {
        calls.push(1)
        return { ok: true, applied: true, diagnostics: [] }
      },
    }
    const tool = shadowVerifyTool(port)
    const ac = new AbortController()
    ac.abort()
    const events = await collect(
      tool as Tool,
      { patch: "*** Begin Patch\n", checks: ["lint"] },
      makeCtx(ac.signal),
    )
    const last = events.at(-1)
    expect(last?.type).toBe("result")
    if (last?.type === "result") {
      expect(last.result.ok).toBe(false)
      expect(last.result.output).toContain("aborted")
    }
    expect(calls).toEqual([])
  })
})

// ─── HELL-SVT-10 / HELL-SVT-11 ─────────────────────────────────────────────

describe("rendering (HELL-SVT-10/11)", () => {
  test("renderShadowVerifyResult prints applied/ok header + diagnostics in order", () => {
    const out = renderShadowVerifyResult({
      ok: false,
      applied: true,
      diagnostics: [
        { file: "x.ts", line: 1, severity: "error", message: "first", source: "lint" },
        {
          file: "y.ts",
          line: 2,
          col: 4,
          severity: "warning",
          message: "second",
          source: "typecheck",
        },
      ],
    })
    const lines = out.split("\n")
    expect(lines[0]).toBe("applied: yes")
    expect(lines[1]).toBe("ok: no")
    expect(lines[2]).toBe("x.ts:1 [error] first (lint)")
    expect(lines[3]).toBe("y.ts:2:4 [warning] second (typecheck)")
  })

  test("renderShadowVerifyResult trailer 'no diagnostics' when empty", () => {
    const out = renderShadowVerifyResult({ ok: true, applied: true, diagnostics: [] })
    expect(out.endsWith("no diagnostics")).toBe(true)
  })

  test("formatShadowDiagnostic omits :col when col is undefined", () => {
    const d: ShadowDiagnosticMirror = {
      file: "a.ts",
      line: 5,
      severity: "info",
      message: "  spaced  msg  ",
      source: "lint",
    }
    expect(formatShadowDiagnostic(d)).toBe("a.ts:5 [info] spaced msg (lint)")
  })
})
