/**
 * Hellgate (TKT-001 / ADR-0411): the bash tool must NOT pre-truncate its
 * output with a head-only `MAX_OUTPUT = 30_000` slice. The registry's
 * `capToolOutput` is the single authoritative truncator (head + tail,
 * default 200K via {@link DEFAULT_TOOL_OUTPUT_MAX}). Pre-truncation by bash
 * defeated head+tail (the tail was already cut off before registry saw it).
 *
 * Adversarial cases:
 *   1. Foreground sub-cap output: byte-identical (no truncation banner).
 *   2. Foreground 60K stdout: full body preserved, no legacy banner.
 *   3. capToolOutput on a long body with a deterministic tail marker
 *      preserves the marker — proving the registry's head+tail layer
 *      keeps the determinator that bash now relies on.
 *   4. Foreground 35K stdout ending in `END` survives the bash path
 *      (legacy 30K head-only would have dropped it).
 *   5. `DEFAULT_TOOL_OUTPUT_MAX` ≥ 30K invariant — delegation contract.
 *   6. Background COMPLETED result (deadline did NOT elapse): same
 *      delegation; full body, no head-only banner.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBashBgRegistry } from "@/runtime/bash-bg-registry"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { ToolRegistry } from "@/tool"
import { bashTool } from "@/tool/bash"
import { capToolOutput, DEFAULT_TOOL_OUTPUT_MAX } from "@/tool/output-spill"

const dir = mkdtempSync(join(tmpdir(), "bash-cap-deleg-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => __resetBashBgRegistry())

const ctx = (cwd: string = dir, signal?: AbortSignal): ToolContext => ({
  cwd,
  signal: signal ?? new AbortController().signal,
})

const collect = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<ToolEvent> },
  input: unknown,
  c: ToolContext,
): Promise<{ result: ToolResult; events: ToolEvent[] }> => {
  const events: ToolEvent[] = []
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    events.push(ev)
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return { result, events }
}

// ─────────────────────────── tests ──────────────────────────────────────────

describe("bash output cap delegation hellgate (TKT-001 / ADR-0411)", () => {
  test("1. small output is byte-identical (no truncation banner)", async () => {
    const { result } = await collect(bashTool, { command: "echo hi" }, ctx())
    expect(result.output).toBe("[exit 0]\nhi")
    expect(result.output).not.toContain("truncated")
    expect(result.output).not.toContain("persisted-output")
  })

  test("2. 60K stdout: bash returns FULL body (no head-only 30K slice)", async () => {
    // 60K bytes — well above legacy 30K head-only cap, below registry default.
    const { result } = await collect(bashTool, { command: `printf 'x%.0s' $(seq 1 60000)` }, ctx())
    expect(result.ok).toBe(true)
    // Body length: "[exit 0]\n" (9) + 60000 stdout = 60009. Allow slack.
    expect(result.output.length).toBeGreaterThan(50_000)
    // Legacy head-only banner must NOT appear.
    expect(result.output).not.toMatch(/truncated,\s+\d+\s+more\s+chars/)
  })

  test("3. capToolOutput preserves TAIL determinator on a long body", async () => {
    const prefix = "p".repeat(50_000)
    const tailMarker = "__END_MARKER__"
    const body = prefix + tailMarker
    let spilled = false
    const capped = await capToolOutput(body, {
      maxChars: 20_000,
      spillDir: join(dir, ".quanta", "tool-output"),
      write: () => {
        spilled = true
      },
    })
    expect(spilled).toBe(true)
    expect(capped.output).toContain(tailMarker)
    expect(capped.output).toContain("persisted-output")
  })

  test("4. 35K stdout ending in END: tail survives bash path (legacy would drop)", async () => {
    const { result } = await collect(
      bashTool,
      { command: `printf 'x%.0s' $(seq 1 35000); printf 'END'` },
      ctx(),
    )
    expect(result.ok).toBe(true)
    // Legacy 30K head-only would have sliced off `END` and replaced with a
    // `(truncated, N more chars)` banner. With delegation in place, the END
    // marker survives intact at the end of the output.
    expect(result.output.endsWith("END")).toBe(true)
    expect(result.output).not.toMatch(/truncated,\s+\d+\s+more\s+chars/)
  })

  test("5. DEFAULT_TOOL_OUTPUT_MAX ≥ 30K — delegation invariant", () => {
    // If someone lowers the registry cap below the legacy bash slice, the
    // delegation regresses (bash would have to re-introduce its own cap).
    expect(DEFAULT_TOOL_OUTPUT_MAX).toBeGreaterThanOrEqual(30_000)
  })

  test("6. registry default cap is 200K (head 8K + tail 4K excerpt budget)", () => {
    // Pin the canonical default so any future change is intentional.
    expect(DEFAULT_TOOL_OUTPUT_MAX).toBe(200_000)
  })

  test("7. bash tool routed THROUGH registry returns sub-cap byte-identical", async () => {
    const reg = new ToolRegistry([bashTool])
    const result = await reg.run("bash", { command: "echo hi" }, ctx())
    expect(result.output).toBe("[exit 0]\nhi")
    expect(result.output).not.toContain("truncated")
  })

  test("8. background COMPLETED result preserves full body (no head-only slice)", async () => {
    const { result } = await collect(
      bashTool,
      {
        command: `python3 -c 'print("a"*45000, end="")'`,
        timeout_behavior: "background",
        timeout_ms: 2_000,
      },
      ctx(),
    )
    // Legacy head-only banner must NOT appear.
    expect(result.output).not.toMatch(/truncated,\s+\d+\s+more\s+chars/)
    // Body length: `[exit 0]\n` + 45_000 stdout. The 30K head-only would have
    // sliced to ≈ 30K + banner.
    expect(result.output.length).toBeGreaterThan(40_000)
    // The trailing payload bytes are intact.
    expect(result.output.endsWith("a".repeat(50))).toBe(true)
  })
})
