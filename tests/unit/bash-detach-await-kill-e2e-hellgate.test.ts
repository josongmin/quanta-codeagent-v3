/**
 * ADR-0296 auto-background — END-TO-END hellgate: a command auto-backgrounded
 * via the NEW `runShell`-adopt path (foreground deadline → detach into the
 * registry) must be resumable by `bash_await` (regex match against captured
 * output) and terminable by `bash_kill`. This is the feature's whole point —
 * detach is useless if the model can't pick the shell back up.
 *
 * This wires the REAL singleton registry (`getBashBgRegistry()`) end-to-end:
 * the bash tool's adopt closure registers into it; `bash_await`/`bash_kill`
 * read from it. Real `bash` children (POSIX only).
 *
 * Chain:
 *   1. bash {timeout_behavior:"background", timeout_ms:150} on a slow command
 *      that emits a marker THEN sleeps ⇒ detaches ⇒ `[bash background] shellId=…`
 *   2. bash_await {shell_id, regex:"MARKER"} ⇒ matches the pre-detach output
 *      captured by the adopted buffer (proves the registry holds the live shell)
 *   3. bash_kill {shell_id} ⇒ terminates the still-running child + reaps it
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBashBgRegistry, getBashBgRegistry } from "@/runtime/bash-bg-registry"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"
import { makeBashAwaitTool } from "@/tool/bash/await"
import { makeBashKillTool } from "@/tool/bash/kill"

const POSIX = process.platform !== "win32"
const dir = mkdtempSync(join(tmpdir(), "bash-detach-e2e-"))

// `afterAll`, NOT `process.on("exit")`. Bun's test runner does not fire an
// exit hook for a test file, so that form never ran and every fixture dir it
// created stayed on disk — enough of them to make `ls /tmp` slow enough to
// time other tests out.
afterAll(() => {
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

// RFC02-2 — production dispatch stamps a stable session `ownerId`; the bash
// tool marks the detached shell with it and `bash_kill` kills ONLY owner-scoped
// shells. Both the adopt (bashTool) and the kill (bash_kill) run under the SAME
// owner here, so the own-shell kill succeeds.
const OWNER = "sess-e2e"
const ctx = (): ToolContext => ({
  cwd: dir,
  signal: new AbortController().signal,
  ownerId: OWNER,
})

const collect = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<ToolEvent> },
  input: unknown,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe.if(POSIX)("detach → bash_await → bash_kill (real runShell-adopt path)", () => {
  test("a detached shell is found by bash_await (regex match) and terminated by bash_kill", async () => {
    // 1. Run a command that prints a MARKER, then sleeps past the deadline.
    const bgResult = await collect(bashTool, {
      command: "printf 'MARKER-LINE\\n'; sleep 5",
      timeout_ms: 150,
      timeout_behavior: "background",
    })
    expect(bgResult.ok).toBe(true)
    expect(bgResult.output).toContain("[bash background]")
    const shellId = bgResult.output.match(/shellId=(\S+)/)?.[1]
    expect(shellId).toBeDefined()
    // The detached shell is live in the SINGLETON registry the bash tool adopted into.
    expect(getBashBgRegistry().size()).toBe(1)
    expect(getBashBgRegistry().get(shellId as string)?.status).toBe("running")

    // 2. bash_await finds it by id and the regex matches the captured pre-detach output.
    const awaited = await collect(makeBashAwaitTool(), {
      shell_id: shellId,
      regex: "MARKER-LINE",
      timeout_ms: 3000,
    })
    expect(awaited.ok).toBe(true)
    expect(awaited.output).toContain("MARKER-LINE") // output captured by the adopted buffer

    // 3. bash_kill terminates the still-running child and reaps it.
    const killed = await collect(makeBashKillTool(), { shell_id: shellId })
    expect(killed.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(getBashBgRegistry().get(shellId as string)?.status).not.toBe("running")
  }, 15_000)

  test("bash_await on an unknown shell_id ⇒ typed not_found (no detached shell leaks an id)", async () => {
    const awaited = await collect(makeBashAwaitTool(), {
      shell_id: "00000000-0000-0000-0000-000000000000",
      timeout_ms: 100,
    })
    expect(awaited.ok).toBe(false)
  })
})
