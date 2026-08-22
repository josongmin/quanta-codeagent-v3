/**
 * DOF-21 MEDIUM-tier real-loop proof — `read-file-unchanged-dedup` (H9).
 *
 * The component-plane test (`tests/unit/read-file-unchanged-dedup-e2e-hellgate.test.ts`)
 * calls `readTool.execute()` directly — no `runAgent`, no dispatch layer. This
 * test proves the dedup fires through the REAL agent loop:
 *
 *   process.env.QUANTA_READ_DEDUP=1
 *     + cfg.readFileState (ReadFileState passed into AgentConfig → ToolContext)
 *     + real runAgent dispatch
 *   ⟹ the second identical-range read of the same file short-circuits at the
 *       tool site and returns a `file_unchanged:` sentinel to the LLM.
 *
 * Two cases:
 *   1. Gate ON — second read of same path returns `file_unchanged:` sentinel in
 *      the tool_result seen by the LLM on its next turn.
 *   2. PAIRED CONTROL — gate OFF → both reads return full content; no sentinel.
 *
 * No production code changed. `process.env.QUANTA_READ_DEDUP` is isolated via
 * `afterEach` + `__resetRuntimeConfig()` so parallel tests see no pollution.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import type { Message } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { ReadFileState } from "@/tool/stale-read-guard"
import { cfg, ev, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

// Temp dir: each test run gets a dedicated dir so file paths stay within the
// fs-jail (`ctx.cwd = dir`) and cleanup is deterministic.
const dir = mkdtempSync(join(tmpdir(), "dedup-real-loop-"))
const FILE = join(dir, "probe.ts")
// Fixed content so the hash is stable across both reads — the dedup key is the
// CONTENT HASH (UUX-6-07), not mtime, so we just need byte-identical reads.
writeFileSync(FILE, "export const x = 42\n")

afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  delete process.env.QUANTA_READ_DEDUP
  __resetRuntimeConfig()
})

/** The sentinel prefix emitted by `renderFileUnchanged`. */
const FILE_UNCHANGED_MARK = "file_unchanged:"

/** Collect every tool_result content string that reached the LLM. */
const allToolResults = (msgs: Message[][]): string =>
  msgs
    .flat()
    .flatMap((m) => m.content)
    .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
    .join("\n")

describe("read-file-unchanged-dedup — real runAgent loop (DOF-21 MEDIUM proof)", () => {
  test("gate ON: second read of same path returns file_unchanged sentinel through real dispatch", async () => {
    process.env.QUANTA_READ_DEDUP = "1"
    __resetRuntimeConfig()

    // Turn 1: read FILE (records content hash). Turn 2: re-read same FILE,
    // same effective range (offset=1, limit=DEFAULT) → hash matches → dedup fires.
    // Turn 3: text stop after the LLM sees the sentinel.
    // ScriptedLLM takes Step[] — wrap StreamEvent[] payloads with ev().
    const llm = new ScriptedLLM([
      ev(toolUse("rd1", "read", { path: FILE })),
      ev(toolUse("rd2", "read", { path: FILE })),
      ev(text("done")),
    ])

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          cwd: dir,
          // ReadFileState carries the per-session content-hash map.
          // In production the assembler mints it; in bare runAgent tests we pass it explicitly.
          readFileState: new ReadFileState(),
          maxTurns: 8,
        }),
      ),
      20_000,
      "read-dedup-gate-on",
    )

    expect(out.reason).toBe("completed")
    // Second read must have produced the dedup sentinel (not full content).
    expect(allToolResults(llm.seenMessages)).toContain(FILE_UNCHANGED_MARK)
  })

  test("CONTROL: gate OFF → both reads return full content, no dedup sentinel", async () => {
    // QUANTA_READ_DEDUP absent ⟹ runtimeConfig().readDedup === false ⟹ tryReadDedup
    // returns null immediately without hashing — dedup never fires.
    delete process.env.QUANTA_READ_DEDUP
    __resetRuntimeConfig()

    const llm = new ScriptedLLM([
      ev(toolUse("rd1", "read", { path: FILE })),
      ev(toolUse("rd2", "read", { path: FILE })),
      ev(text("done")),
    ])

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          cwd: dir,
          readFileState: new ReadFileState(),
          maxTurns: 8,
        }),
      ),
      20_000,
      "read-dedup-gate-off",
    )

    expect(out.reason).toBe("completed")
    // Gate off → no sentinel in any tool_result (both reads returned full content).
    expect(allToolResults(llm.seenMessages)).not.toContain(FILE_UNCHANGED_MARK)
  })
})
