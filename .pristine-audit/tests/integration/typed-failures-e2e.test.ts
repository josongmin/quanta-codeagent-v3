/**
 * E2E: typed `ToolFailure` round-trips from a REAL tool (bash / read) through
 * the dispatch normalization layer and onto `DispatchResult.failure` — the
 * surface the agent loop forwards to the model so it can branch on the failure
 * KIND instead of regex-sniffing `preview`.
 *
 * The unit suite `tests/unit/agent/tool-failure-mode.test.ts` proves the
 * normalization end of the pipe with a scripted in-line tool; this suite
 * proves the TOOL end — the bash binary actually exits 124 / 126 / 127, the
 * fs port actually raises ENOENT, and the resulting `DispatchResult.failure`
 * carries the typed mode VERBATIM.
 *
 * Three covered modes (the gap-closure set):
 *   - bash + sleep + timeout_ms ⇒ failure.mode === "timeout"
 *   - bash + chmod-644 script    ⇒ failure.mode === "permission_denied"
 *   - read + missing path        ⇒ failure.mode === "not_found"
 *
 * Each case ALSO asserts byte-identical preview/ok so the absorb-#2 invariant
 * ("`failure` is ADDITIVE — never replaces `output`") holds end-to-end.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { ToolRegistry } from "@/tool"
import { bashTool } from "@/tool/bash"
import { readTool } from "@/tool/read"

const dir = mkdtempSync(join(tmpdir(), "typed-fail-e2e-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const perm: PermissionContext = { mode: "acceptEdits" }
const ac = new AbortController()

const config = (): AgentConfig =>
  ({
    registry: new ToolRegistry([bashTool, readTool]),
    cwd: dir,
    signal: ac.signal,
    planMode: false,
    permission: perm,
  }) as AgentConfig

const call = (id: string, name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

describe("e2e: typed failure surfaces verbatim from real tools through dispatch", () => {
  test("bash + timeout_ms ⇒ DispatchResult.failure {mode:'timeout', timeoutMs}", async () => {
    // ADR-0296 auto-background now SHIPS ON (a deadline detaches into the bg
    // registry, ok:true). This test exercises the legacy kill-on-deadline path —
    // the one that mints the typed `timeout` FAILURE — so it opts in explicitly.
    const res = await dispatchTool(
      call("c-timeout", "bash", {
        command: "sleep 5",
        timeout_ms: 40,
        timeout_behavior: "kill",
      }),
      config(),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.failure).toEqual({ mode: "timeout", timeoutMs: 40 })
    // ADDITIVE invariant: human `preview` still carries the `[timed out]`
    // marker — the failure field is IN ADDITION TO, not instead of, the
    // existing text the model already learned to read.
    expect(res.preview).toContain("[timed out]")
  })

  test("read + missing path ⇒ DispatchResult.failure {mode:'not_found', path}", async () => {
    const ghost = join(dir, "ghost-e2e.txt")
    const res = await dispatchTool(call("c-missing", "read", { path: ghost }), config(), perm)
    expect(res.ok).toBe(false)
    expect(res.failure).toEqual({ mode: "not_found", path: ghost })
    // The model-facing preview still contains the human-readable diagnostic.
    expect(res.preview.toLowerCase()).toContain("not found")
  })

  test("bash + non-exec script ⇒ DispatchResult.failure {mode:'permission_denied'}", async () => {
    const sh = join(dir, "not-exec-e2e.sh")
    writeFileSync(sh, "echo hi\n", { mode: 0o644 })
    const res = await dispatchTool(call("c-noexec", "bash", { command: sh }), config(), perm)
    expect(res.ok).toBe(false)
    // Platform sanity: bash MUST print "Permission denied" on stderr.
    expect(res.preview.toLowerCase()).toContain("permission denied")
    expect(res.failure?.mode).toBe("permission_denied")
    if (res.failure?.mode === "permission_denied") {
      // Real OS denial — not a session read-only mode refusal.
      expect(res.failure.isReadonly === undefined || res.failure.isReadonly === false).toBe(true)
    }
  })

  test("ok:true bash carries NO failure field (byte-identical default)", async () => {
    const res = await dispatchTool(call("c-ok", "bash", { command: "echo hello" }), config(), perm)
    expect(res.ok).toBe(true)
    expect("failure" in res).toBe(false)
    expect(res.failure).toBeUndefined()
  })
})
