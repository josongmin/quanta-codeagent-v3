/**
 * WIRING-PROOF for repro-doubt (test-quality §wiring-proof): the pure reducer is
 * unit-tested in repro-doubt-guard.test.ts; THIS proves the guard actually ENGAGES
 * through the real `dispatchTool` chokepoint (not theater / built-not-wired).
 *
 * Drives edit → bash → bash → bash on ONE shared config (so `config.reproDoubtState`
 * persists across calls, the way the live loop carries it) and asserts the steer is
 * injected into the tool result on the stuck-trip — and NEVER when the knob is off.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { createReproDoubtState, REPRO_DOUBT_STEER } from "@/agent/repro-doubt-guard"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import type { PermissionContext } from "@/permission"
import type { ToolUseBlock } from "@/llm"
import { z } from "zod"

const tool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: `${name} stub`,
  // include `command` so the registry's safeParse doesn't strip it before
  // extractShellCommand reads it (zod objects drop unknown keys).
  inputSchema: z.object({ command: z.string().optional() }) as z.ZodType<unknown>,
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  // Expose the shell command so the jun-28 repro-doubt gate can see it's test-like
  // (mirrors the real bash tool's extractShellCommand surface).
  extractShellCommand: (input: unknown) =>
    (input as { command?: string } | null)?.command ?? null,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: `${name} ran` } }
  },
})

const perm: PermissionContext = { mode: "acceptEdits" }

const mkConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([tool("edit", false), tool("bash", true)]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
    ...over,
  }) as AgentConfig

const call = (name: string, id: string, input: unknown = {}): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const previews = async (cfg: AgentConfig, names: string[]): Promise<string[]> => {
  const out: string[] = []
  let i = 0
  for (const n of names) {
    // a `bash` here is a TEST re-run (the streak the guard watches) — give it a
    // test-like command so the jun-28 gate counts it.
    const input = n === "bash" ? { command: "python -m pytest tests/x.py" } : {}
    const r = await dispatchTool(call(n, `c${i++}`, input), cfg, perm)
    out.push(r.preview)
  }
  return out
}

describe("repro-doubt wiring (dispatchTool chokepoint)", () => {
  test("ENGAGES: steer injected on the 3rd test re-run after an edit (stuckRuns=3)", async () => {
    const cfg = mkConfig({ reproDoubt: { stuckRuns: 3 }, reproDoubtState: createReproDoubtState() })
    const p = await previews(cfg, ["edit", "bash", "bash", "bash"])
    const has = (i: number): boolean => (p[i] ?? "").includes(REPRO_DOUBT_STEER)
    expect(has(0)).toBe(false) // edit
    expect(has(1)).toBe(false) // run 1
    expect(has(2)).toBe(false) // run 2
    expect(has(3)).toBe(true) // run 3 → trips
    expect((p[3] ?? "").includes("bash ran")).toBe(true) // and the real tool output survives
  })

  test("DEFAULT-OFF byte-identical: no steer when reproDoubt unset", async () => {
    const cfg = mkConfig() // no reproDoubt / no reproDoubtState
    const p = await previews(cfg, ["edit", "bash", "bash", "bash", "bash", "bash"])
    expect(p.every((x) => !x.includes(REPRO_DOUBT_STEER))).toBe(true)
  })

  test("fires at most once across a longer stuck streak", async () => {
    const cfg = mkConfig({ reproDoubt: { stuckRuns: 3 }, reproDoubtState: createReproDoubtState() })
    const p = await previews(cfg, ["edit", "bash", "bash", "bash", "bash", "bash"])
    expect(p.filter((x) => x.includes(REPRO_DOUBT_STEER)).length).toBe(1)
  })
})
