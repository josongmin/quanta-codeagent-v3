/**
 * Typed per-failure-mode classification for bash/read/edit (extends absorb #2).
 *
 * The closed `ToolFailure` union already exists in `@/tool` (`not_found |
 * permission_denied | rejected | timeout | spawn_error | error`). This suite
 * closes the remaining classification gaps at the tool boundary:
 *
 *   - `bash`   — exit 126 + `Permission denied` stderr ⇒ `permission_denied`
 *                (a real OS exec-denial, distinct from spawn_error / timeout).
 *   - `read`   — ENOENT on a missing path ⇒ `not_found` (was an uncaught throw
 *                pre-absorb; the loop dispatched a generic catch-all error).
 *   - `edit`   — old_string mismatch ⇒ `not_found` (regression guard; already
 *                wired by the strategy-hint extraction).
 *
 * INVARIANT: every classification is OPT-IN + ADDITIVE. A tool that does NOT
 * set `failure` (e.g. a plain non-zero exit, an ok:true read) is byte-identical
 * — the `failure in result` membership check below asserts this.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"
import { editTool } from "@/tool/edit"
import { readTool } from "@/tool/read"

const dir = mkdtempSync(join(tmpdir(), "typed-fail-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const drive = async (
  tool: typeof bashTool | typeof readTool | typeof editTool,
  input: unknown,
  c: ToolContext = ctx(dir),
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("(a) bash timeout ⇒ failure.mode: 'timeout'", () => {
  test("sleep over deadline → ok:false, failure.timeout with timeoutMs", async () => {
    // `timeout_behavior:"kill"` exercises the legacy SIGTERM-on-deadline path.
    // The auto-background default is now `"background"` (parsers.ts) which would
    // DETACH the still-running child into the bg registry (ok:true) instead of
    // killing it; the per-call `"kill"` override restores kill-on-deadline so
    // the deadline yields ok:false + failure.mode:"timeout".
    const r = await drive(bashTool, {
      command: "sleep 5",
      timeout_ms: 30,
      timeout_behavior: "kill",
    })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("timeout")
    if (r.failure?.mode === "timeout") {
      expect(r.failure.timeoutMs).toBe(30)
    }
    // `output` text preserved verbatim (model still sees `[timed out]`).
    expect(r.output).toContain("[timed out]")
  })
})

describe("(b) read missing file ⇒ failure.mode: 'not_found' (gap closure)", () => {
  test("ENOENT on stat() is caught and surfaced as a typed not_found", async () => {
    const ghost = join(dir, "ghost-missing-file.txt")
    const r = await drive(readTool, { path: ghost })
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "not_found", path: ghost })
    // Some human-readable diagnostic survives in `output` (for the model trace).
    expect(r.output.length).toBeGreaterThan(0)
  })

  test("read after a successful write produces NO failure (no-false-positive)", async () => {
    const f = join(dir, "exists.txt")
    writeFileSync(f, "hi")
    const r = await drive(readTool, { path: f })
    expect(r.ok).toBe(true)
    expect("failure" in r).toBe(false)
    expect(r.failure).toBeUndefined()
  })
})

describe("(c) read fs-jail escape ⇒ failure.mode: 'rejected' (regression guard)", () => {
  // The current `ToolFailure` union models a jail escape as
  // `permission_denied` (the FS jail is a permission boundary, not a model-
  // visible 'rejection'). This regression test pins that mapping so a future
  // re-classification cannot silently weaken the surfaced reason.
  test("read of a path outside the jail ⇒ permission_denied{isReadonly:false}", async () => {
    const jail = mkdtempSync(join(tmpdir(), "typed-fail-jail-"))
    const outside = mkdtempSync(join(tmpdir(), "typed-fail-outside-"))
    const victim = join(outside, "secret.txt")
    writeFileSync(victim, "top-secret")
    try {
      const prev = process.env.QUANTA_FS_JAIL
      delete process.env.QUANTA_FS_JAIL
      const r = await drive(readTool, { path: victim }, ctx(jail))
      expect(r.ok).toBe(false)
      expect(r.failure).toEqual({
        mode: "permission_denied",
        path: victim,
        isReadonly: false,
      })
      if (prev !== undefined) process.env.QUANTA_FS_JAIL = prev
    } finally {
      rmSync(jail, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("(d) edit old_string mismatch ⇒ failure.mode: 'not_found' (regression)", () => {
  test("validation_error / not_found mapping for mismatch is wired", async () => {
    const f = join(dir, "mismatch-typed-fail.txt")
    writeFileSync(f, "const a = 1")
    const r = await drive(editTool, {
      path: f,
      old_string: "definitely-not-in-the-file",
      new_string: "x",
    })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("not_found")
    if (r.failure?.mode === "not_found") {
      expect(r.failure.path).toBe(f)
    }
  })
})

describe("(e) byte-identical default — tools that don't classify carry no `failure`", () => {
  test("ordinary non-zero bash exit ⇒ NO failure field (legacy path preserved)", async () => {
    const r = await drive(bashTool, { command: "false" })
    expect(r.ok).toBe(false)
    expect("failure" in r).toBe(false)
    expect(r.failure).toBeUndefined()
  })

  test("ok:true edit ⇒ no failure", async () => {
    const f = join(dir, "ok-edit.txt")
    writeFileSync(f, "alpha")
    const r = await drive(editTool, { path: f, old_string: "alpha", new_string: "beta" })
    expect(r.ok).toBe(true)
    expect("failure" in r).toBe(false)
  })
})

describe("(f) bash permission-denied stderr ⇒ failure.mode: 'permission_denied' (gap closure)", () => {
  // `bash -lc <non-executable>` exits 126 with `Permission denied` on stderr.
  // Build a non-executable file and try to execute it; the OS denies exec
  // (chmod 644). The mapping is exit==126 AND stderr contains "Permission
  // denied", to avoid misclassifying an unrelated 126 exit.
  test("running a non-exec file ⇒ permission_denied (real OS denial)", async () => {
    const sh = join(dir, "not-exec.sh")
    writeFileSync(sh, "echo hi\n", { mode: 0o644 })
    const r = await drive(bashTool, { command: sh })
    expect(r.ok).toBe(false)
    // First sanity-check the platform: bash MUST print "Permission denied"
    // on stderr for chmod 644 exec on macOS+Linux (the only supported dev
    // platforms). If this assertion ever flips on an exotic /bin/sh, the
    // platform skip needs to be made explicit — not a silent classifier
    // regression.
    expect(r.output.toLowerCase()).toContain("permission denied")
    // The classifier should then surface a typed `permission_denied`
    // failure (NOT `spawn_error` — the file *was* found; the kernel refused
    // the exec).
    expect(r.failure?.mode).toBe("permission_denied")
    if (r.failure?.mode === "permission_denied") {
      // `isReadonly` absent or false — this is a real OS-level denial, not a
      // session read-only mode refusal.
      expect(r.failure.isReadonly === undefined || r.failure.isReadonly === false).toBe(true)
    }
  })
})
