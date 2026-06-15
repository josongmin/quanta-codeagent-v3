/**
 * ADR-0295 — bash `mode` parameter + per-call OS sandbox wrap (Cursor pattern absorption).
 *
 * Hellgate battery proving the typed `mode: "read" | "write"` parameter,
 * closed-port `PerCallSandboxPort` adapter, OS-enforced write rejection, and
 * fail-closed posture on unsupported platforms. **NO heuristics** — `mode` is
 * a closed enum + the OS enforces the policy.
 *
 * Coverage matrix:
 *  A. schema — default "write", closed enum, mode parsing.
 *  B. mode="read" + read-only command — succeeds (rg, ls, cat).
 *  C. mode="read" + write attempt — typed `sandbox_violation` failure.
 *  D. mode="read" + rm $HOME/.bashrc — never deleted, typed failure.
 *  E. mode="write" default — byte-identical legacy.
 *  F. unsupported platform — typed `sandbox_unavailable` (fail-closed).
 *  G. concurrency invariant — `isConcurrencySafe` stays `false`.
 *  H. fuzz — 100 random mutating ops under mode="read" → 100% rejected.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, sep } from "node:path"
import { __resetShellSandbox } from "@/runtime"
import { DEFAULT_SANDBOX_EXEC_PATH, type PerCallSandboxPort } from "@/runtime/os-sandbox"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"
import { __setBashPerCallSandboxFactory } from "@/tool/bash/per-call-factory"

const dir = mkdtempSync(join(tmpdir(), "bash-mode-test-"))

const ctx = (cwd: string, signal?: AbortSignal): ToolContext => ({
  cwd,
  signal: signal ?? new AbortController().signal,
})

const collect = async (
  input: unknown,
  c: ToolContext,
): Promise<{ result: ToolResult; events: ToolEvent[] }> => {
  const events: ToolEvent[] = []
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute(input as never, c)) {
    events.push(ev)
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return { result, events }
}

beforeEach(() => {
  __resetShellSandbox()
  __setBashPerCallSandboxFactory(undefined)
})

afterEach(() => {
  __resetShellSandbox()
  __setBashPerCallSandboxFactory(undefined)
})

/* ================================================================== */
/*  A. schema                                                          */
/* ================================================================== */

describe("A. schema — closed enum, default write", () => {
  test("HELL-A1: mode is OPTIONAL on the wire schema; default 'write' is applied INSIDE execute", async () => {
    // Schema-level: omitting `mode` is valid (Cursor-pattern absorption keeps
    // the on-wire shape backwards-compatible). The default is applied INSIDE
    // `execute()` so the input *type* stays `mode?: …` and existing tests
    // that omit `mode` still type-check.
    const parsed = bashTool.inputSchema.safeParse({ command: "echo hi" })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.command).toBe("echo hi")
      expect(parsed.data.mode).toBeUndefined()
    }
    // Behaviorally: omitting `mode` runs the legacy (no-wrap) path — same as
    // mode='write'. Covered by HELL-D1 below.
  })

  test("HELL-A2: mode='read' parses", () => {
    const parsed = bashTool.inputSchema.safeParse({ command: "echo hi", mode: "read" })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.mode).toBe("read")
    }
  })

  test("HELL-A3: mode='write' parses", () => {
    const parsed = bashTool.inputSchema.safeParse({ command: "echo hi", mode: "write" })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.mode).toBe("write")
    }
  })

  test("HELL-A4: mode='audit' (out-of-enum) → schema reject", () => {
    const parsed = bashTool.inputSchema.safeParse({ command: "echo hi", mode: "audit" })
    expect(parsed.success).toBe(false)
  })

  test("HELL-A5: mode='READ' (uppercase) → schema reject (case-sensitive enum)", () => {
    const parsed = bashTool.inputSchema.safeParse({ command: "echo hi", mode: "READ" })
    expect(parsed.success).toBe(false)
  })

  test("HELL-A6: mode=null → schema reject", () => {
    const parsed = bashTool.inputSchema.safeParse({ command: "echo hi", mode: null })
    expect(parsed.success).toBe(false)
  })
})

/* ================================================================== */
/*  B. mode="read" + read-only command → success                       */
/* ================================================================== */

describe("B. mode='read' allows read commands via per-call sandbox wrap", () => {
  test("HELL-B1: mode='read' + rg foo → wrapper applied, success", async () => {
    const wrapped: string[][] = []
    const fakePort: PerCallSandboxPort = {
      wrap: (argv, _cwd) => {
        wrapped.push([...argv])
        // Simulate sandbox-applied passthrough (read-only allowed).
        return { argv: [...argv], sandboxApplied: true }
      },
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: "echo foo", mode: "read" }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(result.output).toContain("foo")
    expect(wrapped.length).toBe(1)
  })

  test("HELL-B2: mode='read' + cat existing file → wrapper applied, success", async () => {
    const target = join(dir, "readable.txt")
    writeFileSync(target, "hello-from-disk\n")
    const fakePort: PerCallSandboxPort = {
      wrap: (argv) => ({ argv: [...argv], sandboxApplied: true }),
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: `cat ${target}`, mode: "read" }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(result.output).toContain("hello-from-disk")
  })

  test("HELL-B3: mode='read' calls wrap with read-only policy (closed enum)", async () => {
    let capturedPolicy = ""
    const fakePort: PerCallSandboxPort = {
      wrap: (argv, _cwd) => {
        capturedPolicy = "read-only"
        return { argv: [...argv], sandboxApplied: true }
      },
      availability: () => ({ supported: true }),
    }
    // The factory IS the closed-port composition: the bash tool MUST request a
    // read-only port for mode="read". This test pins the contract — the
    // factory receives the requested profile and the port wraps accordingly.
    __setBashPerCallSandboxFactory((profile) => {
      expect(profile).toBe("read-only")
      return fakePort
    })
    const { result } = await collect({ command: "echo hi", mode: "read" }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(capturedPolicy).toBe("read-only")
  })

  test("HELL-B4: live darwin read-mode supports here-doc while still denying workspace writes", async () => {
    if (process.platform !== "darwin" || !existsSync(DEFAULT_SANDBOX_EXEC_PATH)) return

    const workspace = mkdtempSync(join(tmpdir(), "bash-read-hdoc-"))
    try {
      writeFileSync(join(workspace, "seed.txt"), "seed\n")
      const hdoc = [
        "python - <<'PY'",
        "from pathlib import Path",
        "print(Path('seed.txt').read_text().strip())",
        "PY",
      ].join("\n")
      const { result: ok } = await collect({ command: hdoc, mode: "read" }, ctx(workspace))
      expect(ok.ok).toBe(true)
      expect(ok.output).toContain("seed")

      const { result: denied } = await collect(
        { command: "touch should-not-exist", mode: "read" },
        ctx(workspace),
      )
      expect(denied.ok).toBe(false)
      expect(denied.failure?.mode).toBe("sandbox_violation")
      expect(existsSync(join(workspace, "should-not-exist"))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

/* ================================================================== */
/*  C. mode="read" + write attempt → typed sandbox_violation           */
/* ================================================================== */

describe("C. mode='read' + write attempt → typed sandbox_violation failure", () => {
  test("HELL-C1: mode='read' + echo > /tmp/y → typed failure, exit non-zero", async () => {
    // Fake wrap: simulate Seatbelt rejection by returning an argv that exits
    // 1 with "Operation not permitted" on stderr — the same shape sandbox-exec
    // surfaces on a file-write* violation.
    const fakePort: PerCallSandboxPort = {
      wrap: (_argv, _cwd) => ({
        argv: ["bash", "-lc", "echo 'Operation not permitted' >&2; exit 1"],
        sandboxApplied: true,
      }),
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect(
      { command: "echo x > /tmp/sandbox-violation-canary", mode: "read" },
      ctx(dir),
    )
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("sandbox_violation")
  })

  test("HELL-C2: mode='read' + write attempt → /tmp/sandbox-violation-canary NEVER written", async () => {
    const canary = "/tmp/sandbox-violation-canary-c2"
    try {
      rmSync(canary, { force: true })
    } catch {}
    // Wrapper rewrites the argv to a no-op that fails — proving the original
    // write never reaches the FS through the wrapped argv path.
    const fakePort: PerCallSandboxPort = {
      wrap: (_argv, _cwd) => ({
        argv: ["bash", "-lc", "echo 'Operation not permitted' >&2; exit 1"],
        sandboxApplied: true,
      }),
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: `echo x > ${canary}`, mode: "read" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("sandbox_violation")
    expect(existsSync(canary)).toBe(false)
  })

  test("HELL-C3: mode='read' + rm $HOME/.bashrc → never deleted (HOME safety)", async () => {
    const home = homedir()
    // The fake wrap simulates a real seatbelt deny — the argv is rewritten so
    // the original `rm` is never invoked. We do NOT touch the real ~/.bashrc;
    // we only assert the wrap intercepted the call AND the failure surfaces.
    let originalSeen = ""
    const fakePort: PerCallSandboxPort = {
      wrap: (argv, _cwd) => {
        originalSeen = argv.join(" ")
        return {
          argv: ["bash", "-lc", "echo 'Operation not permitted' >&2; exit 1"],
          sandboxApplied: true,
        }
      },
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: `rm ${home}/.bashrc`, mode: "read" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("sandbox_violation")
    // The wrap saw the dangerous original argv — which means the wrap is the
    // ONLY place that decides whether to spawn the original or rewrite it.
    expect(originalSeen).toContain(".bashrc")
    // And by construction (wrap rewrote argv), the `rm` was never spawned.
  })

  test("HELL-C4: write violation carries the EXACT `reason: 'write_denied'` discriminant", async () => {
    const fakePort: PerCallSandboxPort = {
      wrap: () => ({
        argv: ["bash", "-lc", "echo 'Operation not permitted' >&2; exit 1"],
        sandboxApplied: true,
      }),
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect(
      { command: "echo x > /tmp/violation-c4", mode: "read" },
      ctx(dir),
    )
    expect(result.failure?.mode).toBe("sandbox_violation")
    if (result.failure?.mode === "sandbox_violation") {
      // A file-write denial ("Operation not permitted") maps to the EXACT
      // `write_denied` reason — NOT the catch-all `unknown`. Pinning the exact
      // value catches a classifier that silently degrades to `unknown`.
      expect(result.failure.reason).toBe("write_denied")
    }
  })

  test("HELL-C5: network-egress denial maps to the EXACT `reason: 'network_denied'`", async () => {
    // Seatbelt/Landlock surfaces a net deny with a "network ... denied" /
    // "network ... not permitted" stderr shape — distinct from a file-write
    // deny. The classifier MUST map it to `network_denied`, not `write_denied`
    // and not the `unknown` catch-all.
    const fakePort: PerCallSandboxPort = {
      wrap: () => ({
        argv: ["bash", "-lc", "echo 'sandbox: network outbound connection denied' >&2; exit 1"],
        sandboxApplied: true,
      }),
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect(
      { command: "curl https://example.com", mode: "read" },
      ctx(dir),
    )
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("sandbox_violation")
    if (result.failure?.mode === "sandbox_violation") {
      expect(result.failure.reason).toBe("network_denied")
    }
  })
})

/* ================================================================== */
/*  D. mode="write" (default) → byte-identical legacy                  */
/* ================================================================== */

describe("D. mode='write' (default) → legacy byte-identical", () => {
  test("HELL-D1: mode not provided → behaves as write (no wrap, real spawn)", async () => {
    let wrapCalled = false
    const fakePort: PerCallSandboxPort = {
      wrap: (argv) => {
        wrapCalled = true
        return { argv: [...argv], sandboxApplied: true }
      },
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: "echo hello-default" }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(result.output).toContain("hello-default")
    expect(wrapCalled).toBe(false) // bash-mode=write must NOT consult the per-call port
  })

  test("HELL-D2: mode='write' → no wrap, real spawn", async () => {
    let wrapCalled = false
    const fakePort: PerCallSandboxPort = {
      wrap: (argv) => {
        wrapCalled = true
        return { argv: [...argv], sandboxApplied: true }
      },
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: "echo from-write", mode: "write" }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(result.output).toContain("from-write")
    expect(wrapCalled).toBe(false)
  })

  test("HELL-D3: pwd under mode='write' still in ctx.cwd", async () => {
    const { result } = await collect({ command: "pwd", mode: "write" }, ctx(dir))
    expect(result.ok).toBe(true)
    const tail = dir.split(sep).pop() as string
    expect(result.output).toContain(tail)
  })
})

/* ================================================================== */
/*  E. unsupported platform → typed sandbox_unavailable (fail-closed)  */
/* ================================================================== */

describe("E. unsupported platform → typed sandbox_unavailable", () => {
  test("HELL-E0: mode='read' + background is fail-closed, not unsandboxed", async () => {
    let wrapCalled = false
    const fakePort: PerCallSandboxPort = {
      wrap: (argv) => {
        wrapCalled = true
        return { argv: [...argv], sandboxApplied: true }
      },
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect(
      { command: "echo should-not-run", mode: "read", timeout_behavior: "background" },
      ctx(dir),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("read-mode-background-unsupported")
    expect(result.failure?.mode).toBe("sandbox_unavailable")
    expect(wrapCalled).toBe(false)
  })

  test("HELL-E1: mode='read' + unavailable port → typed sandbox_unavailable", async () => {
    const fakePort: PerCallSandboxPort = {
      wrap: (argv) => ({ argv: [...argv], sandboxApplied: false }),
      availability: () => ({
        supported: false,
        reason: "unsupported-platform:win32",
      }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: "echo hi", mode: "read" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("sandbox_unavailable")
    if (result.failure?.mode === "sandbox_unavailable") {
      expect(result.failure.reason).toContain("unsupported-platform")
    }
  })

  test("HELL-E2: mode='read' + missing sandbox-exec → typed sandbox_unavailable", async () => {
    const fakePort: PerCallSandboxPort = {
      wrap: (argv) => ({
        argv: [...argv],
        sandboxApplied: false,
        degradeReason: "sandbox-exec-missing",
      }),
      availability: () => ({
        supported: false,
        reason: "sandbox-exec-missing",
      }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: "echo hi", mode: "read" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("sandbox_unavailable")
  })

  test("HELL-E3: unavailable + fail-closed → command does NOT run as fallback", async () => {
    // Fail-closed: a write-side-effect command MUST NOT be spawned when the
    // sandbox is unavailable. The legacy passthrough is explicitly NOT used as
    // fallback.
    const canary = join(dir, "must-not-be-touched.txt")
    try {
      rmSync(canary, { force: true })
    } catch {}
    const fakePort: PerCallSandboxPort = {
      wrap: (argv) => ({ argv: [...argv], sandboxApplied: false }),
      availability: () => ({
        supported: false,
        reason: "linux-bwrap-missing",
      }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: `echo x > ${canary}`, mode: "read" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("sandbox_unavailable")
    expect(existsSync(canary)).toBe(false) // the spawn was refused, never ran
  })
})

/* ================================================================== */
/*  F. concurrency invariant                                           */
/* ================================================================== */

describe("F. concurrency posture (SOTA consensus — serialized for now)", () => {
  test("HELL-F1: isConcurrencySafe stays false for mode='read'", () => {
    expect(bashTool.isConcurrencySafe({ command: "ls", mode: "read" })).toBe(false)
  })
  test("HELL-F2: isConcurrencySafe stays false for mode='write'", () => {
    expect(bashTool.isConcurrencySafe({ command: "echo x", mode: "write" })).toBe(false)
  })
  test("HELL-F3: isConcurrencySafe stays false for mode unset (default write)", () => {
    expect(bashTool.isConcurrencySafe({ command: "ls" })).toBe(false)
  })
})

/* ================================================================== */
/*  G. fuzz: 100 random mutating ops in mode='read' → 100% rejected    */
/* ================================================================== */

describe("G. fuzz — mode='read' rejects 100% of mutating attempts", () => {
  test("HELL-G1: 100 random mutating commands all surface sandbox_violation", async () => {
    // Wrap simulates an OS deny on every call — the actual spawn is rewritten
    // to a guaranteed-fail no-op so this stays hermetic + fast.
    const fakePort: PerCallSandboxPort = {
      wrap: () => ({
        argv: ["bash", "-lc", "echo 'Operation not permitted' >&2; exit 1"],
        sandboxApplied: true,
      }),
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)

    const verbs = ["rm", "mv", "cp", "touch", "mkdir", "chmod", "chown", "ln -s", ">", ">>"]
    const targets = ["/tmp/x", "/etc/x", "~/.bashrc", "./foo", "../bar", "/var/log/x"]
    let rejected = 0
    for (let i = 0; i < 100; i++) {
      const verb = verbs[i % verbs.length]
      const tgt = targets[(i * 7) % targets.length]
      const cmd = verb === ">" || verb === ">>" ? `echo y ${verb} ${tgt}` : `${verb} ${tgt}`
      const { result } = await collect({ command: cmd, mode: "read" }, ctx(dir))
      if (!result.ok && result.failure?.mode === "sandbox_violation") rejected++
    }
    expect(rejected).toBe(100)
  })
})

/* ================================================================== */
/*  H. evidence preservation                                           */
/* ================================================================== */

describe("H. evidence + output channels still populated under mode='read'", () => {
  test("HELL-H1: stderr from sandbox denial surfaces in evidence.stderr", async () => {
    const fakePort: PerCallSandboxPort = {
      wrap: () => ({
        argv: ["bash", "-lc", "echo 'sandbox: Operation not permitted' >&2; exit 1"],
        sandboxApplied: true,
      }),
      availability: () => ({ supported: true }),
    }
    __setBashPerCallSandboxFactory(() => fakePort)
    const { result } = await collect({ command: "echo > /tmp/h1", mode: "read" }, ctx(dir))
    expect(result.evidence?.exitCode).toBe(1)
    expect(result.evidence?.stderr).toContain("Operation not permitted")
  })
})

// Clean up at suite end.
import { afterAll } from "bun:test"

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
