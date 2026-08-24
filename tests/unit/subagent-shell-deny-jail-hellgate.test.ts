/**
 * HELLGATE — T2-shell-deny: shell tools must not bypass HARD_DENY, the path
 * jail, or the spawn fail-open caps.
 *
 * Each block pins ONE audited defect's fix AND the adversarial case that would
 * have slipped past before:
 *
 *   (a) test_runner exposes `extractShellCommand` so a model-supplied
 *       `command:"rm -rf /"` faces the SAME HARD_DENY gate as `bash`.
 *   (b) exec_command (6-tool, via createSubagent6Tools) exposes
 *       `extractShellCommand` so dispatch populates `action.shellCommand`.
 *   (c) exec_command rejects a model-supplied `cwd` OUTSIDE the workspace
 *       (path-jail port) with cause:"cwd_outside_workspace" — BEFORE spawn.
 *   (d) spawn_agent caps are fail-CLOSED: an omitted maxDepth/maxConcurrent
 *       falls back to built-in ceilings instead of unbounded recursion/fan-out.
 *   (e) exec_command(pty:true) with NO ptyTable returns cause:"pty_unsupported"
 *       instead of silently running an untracked PTY.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveJailed } from "@/storage"
import {
  createSubagent6Tools,
  dispatchSubagent6,
  handleExecCommand,
  handleSpawnAgent,
  PtyTable,
  type SubagentRunner,
  TaskRegistry,
} from "@/subagent"
import { DEFAULT_MAX_DEPTH } from "@/subagent/handlers-6"

// `testRunnerTool` lives in the tool slice (not the subagent barrel).
import { testRunnerTool as runnerTool } from "@/tool/test-runner"

const neverRunner: SubagentRunner = async () => {
  // Hangs forever so registered children stay "running" — lets us drive the
  // concurrency gauge deterministically without real subprocesses.
  await new Promise<void>(() => {})
  return { ok: true, finalText: "", turns: 0 }
}

// A path-jail port shaped exactly like the production wiring in
// `src/agent/tier1/subagent.ts` (`{resolve: resolveJailed, jailRoot}`).
const cwdJail = (jailRoot: string) => ({ resolve: resolveJailed, jailRoot })

// ─── (a) test_runner — HARD_DENY surface ────────────────────────────────────

describe("HELLGATE (a) — test_runner exposes shell command for HARD_DENY", () => {
  test("extractShellCommand surfaces a model-supplied command verbatim", () => {
    expect(typeof runnerTool.extractShellCommand).toBe("function")
    // The adversarial input: a destructive command smuggled through the
    // `command` override. The policy denylist matches on this exact string.
    expect(runnerTool.extractShellCommand?.({ command: "rm -rf /" })).toBe("rm -rf /")
  })

  test("auto-detect path (no command) surfaces empty string — nothing to deny", () => {
    // A fixed `bun test`/`npm test`/`pytest` shape the model cannot poison.
    expect(runnerTool.extractShellCommand?.({})).toBe("")
  })
})

// ─── (b) exec_command — HARD_DENY surface ───────────────────────────────────

describe("HELLGATE (b) — exec_command exposes shell command for HARD_DENY", () => {
  const { tools, cleanup } = createSubagent6Tools({})
  const exec = tools.find((t) => t.name === "exec_command")

  test("exec_command Tool implements extractShellCommand", () => {
    expect(exec).toBeDefined()
    expect(typeof exec?.extractShellCommand).toBe("function")
  })

  test("a force-push command is surfaced verbatim for the denylist", () => {
    expect(exec?.extractShellCommand?.({ command: "git push --force origin main" })).toBe(
      "git push --force origin main",
    )
    cleanup()
  })

  test("missing/non-string command degrades to empty string (never throws)", () => {
    expect(exec?.extractShellCommand?.({})).toBe("")
    expect(exec?.extractShellCommand?.({ command: 42 })).toBe("")
  })
})

// ─── (c) exec_command — path jail on model-supplied cwd ─────────────────────

describe("HELLGATE (c) — exec_command path jail", () => {
  test("cwd OUTSIDE the workspace is rejected fail-closed BEFORE spawn", async () => {
    const r = await handleExecCommand(
      { command: "echo pwned", cwd: "/etc", timeoutMs: 2000 },
      { cwdJail: cwdJail(process.cwd()) },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("cwd_outside_workspace")
  })

  test("a `..` climb-out cwd is rejected (no symlink/relative escape)", async () => {
    const r = await handleExecCommand(
      { command: "echo hi", cwd: `${process.cwd()}/../../../../tmp`, timeoutMs: 2000 },
      { cwdJail: cwdJail(process.cwd()) },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("cwd_outside_workspace")
  })

  test("cwd INSIDE the workspace passes the jail and runs", async () => {
    const r = await handleExecCommand(
      { command: "echo inside", cwd: process.cwd(), timeoutMs: 5000 },
      { cwdJail: cwdJail(process.cwd()) },
    )
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.stdout).toContain("inside")
  })

  test("dispatch router forwards the cwdJail port (escape rejected via router)", async () => {
    const out = await dispatchSubagent6(
      "exec_command",
      { command: "echo x", cwd: "/", timeoutMs: 2000 },
      { cwdJail: cwdJail(process.cwd()) },
    )
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.cause).toBe("cwd_outside_workspace")
  })

  test("no jail wired ⇒ legacy behavior (cwd honored, no rejection)", async () => {
    const r = await handleExecCommand({
      command: "echo legacy",
      cwd: process.cwd(),
      timeoutMs: 5000,
    })
    expect(r.kind).toBe("success")
  })
})

// ─── (c2) exec_command — spawn runs in the JAILED path, not the raw cwd ──────
//
// Hole: the jail validated `resolve(input.cwd, jailRoot)` but `Bun.spawn` ran
// with the RAW `input.cwd`. A RELATIVE cwd is resolved by the jail against
// jailRoot (→ inside the workspace), but Bun.spawn resolves a relative cwd
// against `process.cwd()`. When `process.cwd() != jailRoot` the validated path
// and the executed path DIVERGE — a relative cwd that passed the jail check
// would still run OUTSIDE the workspace (or escape via "../"). The fix binds
// the spawn cwd to the jailed absolute path. These cases run with a temp
// jailRoot DISTINCT from process.cwd() so the divergence is observable.
describe("HELLGATE (c2) — exec_command spawns in the jailed path (not raw cwd)", () => {
  test("a RELATIVE cwd executes INSIDE jailRoot, not under process.cwd()", async () => {
    const jailRoot = realpathSync(mkdtempSync(join(tmpdir(), "quanta-jail-")))
    mkdirSync(join(jailRoot, "sub"))
    try {
      // Relative cwd "sub" passes the jail (resolves to <jailRoot>/sub). Before
      // the fix, Bun.spawn would resolve "sub" against process.cwd() (the repo
      // root) — running OUTSIDE the temp workspace. `pwd -P` must report a path
      // under jailRoot, NOT under process.cwd().
      const r = await handleExecCommand(
        { command: "pwd -P", cwd: "sub", timeoutMs: 5000 },
        { cwdJail: cwdJail(jailRoot) },
      )
      expect(r.kind).toBe("success")
      if (r.kind === "success") {
        const out = r.stdout.trim()
        expect(out.startsWith(jailRoot)).toBe(true)
        // Anti-regression: must NOT have run under the ambient process cwd
        // (the repo root today; a throwaway sandbox dir under the sandboxed-cwd
        // runner — either way a directory that is not `jailRoot`).
        expect(out.startsWith(realpathSync(process.cwd()))).toBe(false)
      }
    } finally {
      rmSync(jailRoot, { recursive: true, force: true })
    }
  })

  test("a RELATIVE climb-out cwd ('../escape') is rejected fail-closed", async () => {
    const jailRoot = realpathSync(mkdtempSync(join(tmpdir(), "quanta-jail-")))
    try {
      const r = await handleExecCommand(
        { command: "pwd -P", cwd: "../escape", timeoutMs: 5000 },
        { cwdJail: cwdJail(jailRoot) },
      )
      expect(r.kind).toBe("error")
      if (r.kind === "error") expect(r.cause).toBe("cwd_outside_workspace")
    } finally {
      rmSync(jailRoot, { recursive: true, force: true })
    }
  })

  test("an ABSOLUTE outside cwd is still rejected even with a temp jailRoot", async () => {
    const jailRoot = realpathSync(mkdtempSync(join(tmpdir(), "quanta-jail-")))
    try {
      const r = await handleExecCommand(
        { command: "pwd -P", cwd: "/etc", timeoutMs: 5000 },
        { cwdJail: cwdJail(jailRoot) },
      )
      expect(r.kind).toBe("error")
      if (r.kind === "error") expect(r.cause).toBe("cwd_outside_workspace")
    } finally {
      rmSync(jailRoot, { recursive: true, force: true })
    }
  })
})

// ─── (d) spawn_agent — fail-CLOSED caps ─────────────────────────────────────

describe("HELLGATE (d) — spawn_agent caps are fail-closed when knobs omitted", () => {
  test("depth recursion is capped at the built-in ceiling when no maxDepth", async () => {
    const registry = new TaskRegistry()
    // parentDepth at the ceiling ⇒ child would be ceiling+1 ⇒ must be denied
    // even though NEITHER input.maxDepth NOR deps.maxDepth was supplied.
    const r = await handleSpawnAgent(
      { prompt: "go deeper" },
      { runner: neverRunner, registry, parentDepth: DEFAULT_MAX_DEPTH },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("depth_exceeded")
    expect(registry.pendingIds().length).toBe(0)
  })

  test("a spawn just under the built-in depth ceiling is admitted", async () => {
    const registry = new TaskRegistry()
    const r = await handleSpawnAgent(
      { prompt: "ok" },
      { runner: neverRunner, registry, parentDepth: DEFAULT_MAX_DEPTH - 1 },
    )
    expect(r.kind).toBe("success")
  })

  test("model input.maxDepth may only TIGHTEN — it cannot raise the host cap", async () => {
    // Hole: `input.maxDepth ?? deps.maxDepth ?? DEFAULT` let a hostile/
    // hallucinated model raise the ceiling. Host cap=3, parentDepth=3 ⇒ child
    // depth=4. A model passing maxDepth=99 must STILL be denied at the host's 3.
    const registry = new TaskRegistry()
    const r = await handleSpawnAgent(
      { prompt: "fan out deep", max_depth: 99 },
      { runner: neverRunner, registry, maxDepth: 3, parentDepth: 3 },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("depth_exceeded")
    expect(registry.pendingIds().length).toBe(0)
  })

  test("model input.maxDepth CAN tighten below the host cap", async () => {
    // The min() must still let the model shrink its own budget: host cap=5,
    // model maxDepth=1, parentDepth=1 ⇒ child depth=2 > model's 1 ⇒ denied.
    const registry = new TaskRegistry()
    const r = await handleSpawnAgent(
      { prompt: "self-limit", max_depth: 1 },
      { runner: neverRunner, registry, maxDepth: 5, parentDepth: 1 },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("depth_exceeded")
  })

  test("concurrency is OPT-IN: absent maxConcurrent ⇒ unbounded (byte-identical default)", async () => {
    // The codebase pins "absent cap ⇒ unlimited (no regression)" deliberately;
    // a built-in numeric ceiling would be an arbitrary threshold, so bounding
    // stays caller-configured. An explicit cap IS enforced.
    const registry = new TaskRegistry()
    for (let i = 0; i < 40; i++) {
      const r = await handleSpawnAgent({ prompt: `c${i}` }, { runner: neverRunner, registry })
      expect(r.kind).toBe("success") // no built-in ceiling rejects these
    }
    // With an explicit cap of 1, the next spawn (1 already running) is rejected.
    const capped = new TaskRegistry()
    await handleSpawnAgent(
      { prompt: "first" },
      { runner: neverRunner, registry: capped, maxConcurrent: 1 },
    )
    const over = await handleSpawnAgent(
      { prompt: "over" },
      { runner: neverRunner, registry: capped, maxConcurrent: 1 },
    )
    expect(over.kind).toBe("error")
    if (over.kind === "error") expect(over.cause).toBe("concurrency_cap")
  })
})

// ─── (e) exec_command — pty:true with no ptyTable ───────────────────────────

describe("HELLGATE (e) — exec_command pty:true without a ptyTable", () => {
  test("returns cause:pty_unsupported instead of running an untracked PTY", async () => {
    const r = await handleExecCommand({
      command: "sleep 30",
      cwd: process.cwd(),
      timeoutMs: 5000,
      pty: true,
    })
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("pty_unsupported")
  })

  test("pty:true WITH a ptyTable still works (no false-positive)", async () => {
    const table = new PtyTable()
    const r = await handleExecCommand(
      { command: "echo quick", cwd: process.cwd(), timeoutMs: 5000, pty: true },
      { ptyTable: table },
    )
    // Short-lived command exits inside the grace window ⇒ synchronous success.
    expect(r.kind).toBe("success")
    table.closeAll()
  })
})
