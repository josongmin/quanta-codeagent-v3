/**
 * RFC02-4 (C2) — executor-known bash evidence hellgate.
 *
 * The bash tool computes execution evidence ONCE at the assembly seam and BOTH
 * the model-facing text AND the structured `result.evidence` project from that
 * single source. The RFC's additive, executor-KNOWN facts are:
 *   - `timeoutMs`         — the wall-clock deadline the executor applied;
 *   - `detached`          — the command auto-backgrounded on deadline;
 *   - `backgroundShellId` — the registry id it detached into (from `adopt()`).
 *
 * Load-bearing assertions:
 *  1. DETACH FAN-OUT — on a `background` detach, the SAME shell id appears in
 *     BOTH the model output text and `evidence.backgroundShellId`, and
 *     `evidence.detached === true` with `evidence.timeoutMs` set. A projection
 *     that gave the fact to only one side is the RED this guards.
 *  2. TIMEOUT FAN-OUT — on a `kill`-mode deadline, `evidence.timedOut === true`
 *     and `evidence.timeoutMs` equals the deadline the executor set (NOT parsed
 *     from stderr).
 *  3. NO PARSER — a completed command whose STDERR literally contains the words
 *     "timed out" / a shell id string does NOT fabricate `timeoutMs` /
 *     `detached` / `backgroundShellId` (evidence is executor-known, never a
 *     stderr/command classifier).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBashBgRegistry, getBashBgRegistry } from "@/runtime/bash-bg-registry"
import { bashTool } from "@/tool/bash"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const POSIX = process.platform !== "win32"
const dir = mkdtempSync(join(tmpdir(), "bash-evidence-"))
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

afterEach(async () => {
  await getBashBgRegistry()
    .killAll()
    .catch(() => {})
  __resetBashBgRegistry()
})

const ctx = (): ToolContext => ({ cwd: dir, signal: new AbortController().signal, ownerId: "own" })

const collect = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe.if(POSIX)(
  "RFC02-4 — detach evidence fans out to model text AND structured evidence",
  () => {
    test("a background detach carries the shell id in BOTH output and evidence.backgroundShellId", async () => {
      const res = await collect({
        command: "printf 'MARK\\n'; sleep 5",
        timeout_ms: 150,
        timeout_behavior: "background",
      })
      expect(res.ok).toBe(true)
      const shellId = res.output.match(/shellId=(\S+)/)?.[1]
      expect(shellId).toBeDefined()
      // Single source → both projections carry the SAME fact.
      expect(res.evidence?.backgroundShellId).toBe(shellId as string)
      expect(res.evidence?.detached).toBe(true)
      expect(res.evidence?.timeoutMs).toBe(150)
    }, 15_000)
  },
)

describe.if(POSIX)("RFC02-4 — kill-mode deadline surfaces executor-known timeoutMs", () => {
  test("a timed-out (kill-mode) command reports timedOut + the applied timeoutMs", async () => {
    const res = await collect({
      command: "sleep 5",
      timeout_ms: 120,
      timeout_behavior: "kill",
    })
    expect(res.ok).toBe(false)
    expect(res.evidence?.timedOut).toBe(true)
    expect(res.evidence?.timeoutMs).toBe(120) // the deadline the executor set, not parsed
  }, 15_000)
})

describe.if(POSIX)("RFC02-4 — no stderr/command classifier fabricates control facts", () => {
  test("a COMPLETED command whose stderr says 'timed out' does NOT get timeoutMs/detached", async () => {
    const res = await collect({
      command: ">&2 printf 'error: request timed out shellId=fake-123\\n'; exit 0",
      timeout_behavior: "kill",
    })
    expect(res.ok).toBe(true)
    // The words exist in stderr, but the executor did not time out / detach ⇒
    // no fabricated control facts.
    expect(res.evidence?.timedOut).toBeUndefined()
    expect(res.evidence?.timeoutMs).toBeUndefined()
    expect(res.evidence?.detached).toBeUndefined()
    expect(res.evidence?.backgroundShellId).toBeUndefined()
  }, 15_000)
})
