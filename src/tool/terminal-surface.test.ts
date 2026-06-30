/**
 * RED→GREEN invariants for the Terminal-Bench `terminal` ToolSurface (RFC jun-29).
 *
 * These pin the RFC's HARD spec (S1-S4) + the ownership-boundary audit checks so a future
 * "TB-only branch" can't sneak in:
 *   S1  terminal is a first-class ToolSurface (not bench).
 *   S2  terminal registry is BASE-free (no repo-edit tools inherited).
 *   S3  exec-capable terminal tools are container-bound (docker exec), never host bash.
 *   audit byte-identical: the terminal addition changes NO existing surface's default registry.
 *   audit no-leak: no "TerminalBench|Harbor|BaseAgent" naming outside src/apps/.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildDefaultTools, buildTerminalTools } from "./index"
import { dockerExecTmux } from "./pty/docker-exec-tmux"
import { createTmuxAdapter } from "./pty/tmux-adapter"
import { BASE_TOOL_NAMES, TOOL_SURFACES } from "./surface/manifest"

const PTY_NAMES = ["pty_attach", "pty_list", "pty_write", "pty_read", "pty_resize", "pty_kill"]
const fakePort = () => createTmuxAdapter({ exec: { run: async () => ({ ok: true, stdout: "" }) } })

describe("S1 — terminal is a first-class ToolSurface", () => {
  test('TOOL_SURFACES includes "terminal" (not folded into bench)', () => {
    expect(TOOL_SURFACES).toContain("terminal")
    expect(TOOL_SURFACES).toContain("bench") // still distinct
  })
})

describe("S2 — terminal registry is BASE-free (no repo-edit tools)", () => {
  test("buildTerminalTools = pty_* ONLY, ZERO BASE tools", () => {
    const names = buildTerminalTools({ ptySession: fakePort() }).map((t) => t.name)
    // every tool is a pty tool…
    for (const n of names) expect(PTY_NAMES).toContain(n)
    // …and NONE of the always-on BASE repo-edit/exec set leaked in.
    for (const base of BASE_TOOL_NAMES) expect(names).not.toContain(base)
    // specifically the dangerous host ones:
    for (const forbidden of ["bash", "apply_patch", "edit", "write", "grep", "test_runner"]) {
      expect(names).not.toContain(forbidden)
    }
    expect(names.length).toBeGreaterThan(0) // it DID build the pty family
  })

  test("no ports ⇒ empty (fail-safe, never falls back to BASE)", () => {
    expect(buildTerminalTools({})).toEqual([])
  })

  test("container_exec + pty_* together ⇒ still BASE-free, still no host bash", () => {
    const names = buildTerminalTools({
      ptySession: fakePort(),
      containerExec: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
    }).map((t) => t.name)
    expect(names).toContain("container_exec") // the one-shot workhorse (RFC §13 #1)
    for (const p of PTY_NAMES) expect(names).toContain(p)
    // BASE / host-exec set STILL absent — container_exec is container-bound, NOT host bash.
    for (const base of BASE_TOOL_NAMES) expect(names).not.toContain(base)
    expect(names).not.toContain("bash")
  })
})

describe("S3 — container-bound exec (dockerExecTmux), never host", () => {
  test("every tmux call is wrapped as `docker exec -i <container> tmux <args>`", async () => {
    const calls: string[][] = []
    const exec = dockerExecTmux("ctr-abc123", async (argv) => {
      calls.push([...argv])
      return { ok: true, stdout: "" }
    })
    await exec.run(["new-session", "-d", "-s", "quanta-tb"])
    expect(calls[0]).toEqual([
      "exec",
      "-i",
      "ctr-abc123",
      "tmux",
      "new-session",
      "-d",
      "-s",
      "quanta-tb",
    ])
    await exec.run(["capture-pane", "-p"])
    expect(calls[1]).toEqual(["exec", "-i", "ctr-abc123", "tmux", "capture-pane", "-p"])
  })
})

describe("byte-identical — terminal addition changes NO existing default registry", () => {
  test("buildDefaultTools() (no ports) === BASE_TOOL_NAMES (unchanged)", () => {
    const got = buildDefaultTools()
      .map((t) => t.name)
      .sort()
    expect(got).toEqual([...BASE_TOOL_NAMES].sort())
  })
  test("buildDefaultTools() does NOT include pty tools (terminal is separate)", () => {
    const got = buildDefaultTools().map((t) => t.name)
    for (const p of PTY_NAMES) expect(got).not.toContain(p)
  })
})

describe("ownership boundary — no Terminal-Bench naming leaks outside src/apps/", () => {
  test('no "TerminalBench|terminal-bench|Harbor|BaseAgent" in src/ (excluding src/apps/)', () => {
    // The user's exact forbidden list — these belong ONLY in the src/apps/ entry-point shim.
    const FORBIDDEN = /TerminalBench|terminal-bench|\bHarbor\b|\bBaseAgent\b/i
    const srcDir = join(import.meta.dir, "..") // src/
    const offenders: string[] = []
    // Glob scans NON-TS too: the only genuinely TB-aware artifact is the Python BaseAgent shim,
    // which lives in the entry-point owner (src/apps/ or repo-root adapters/terminal-bench/) — a
    // stray shim / compose / config file DROPPED in the general src/ tree must NOT escape the guard
    // just because it isn't TypeScript. NB the brace shape: `*.{ext}` only matches `<name>.ext`, so
    // a LITERAL `Dockerfile` (no extension) needs its own top-level alternative — `*.{...,Dockerfile}`
    // would silently match NOTHING for it (a real false-coverage bug we fixed). `apps/` = the
    // entry-point shim (startsWith, so `appshot/` is NOT excluded). Skip tests (any kind).
    const SCAN =
      "**/{*.{ts,tsx,py,sh,json,mjs,cjs,mts,cts,yaml,yml,toml,cfg,ini,txt,env},Dockerfile,*.Dockerfile}"
    const isTest = (p: string) => /\.(test|spec)\.[a-z]+$/.test(p) || p.includes("/__")
    for (const rel of new Bun.Glob(SCAN).scanSync(srcDir)) {
      if (rel.startsWith("apps/") || isTest(rel)) continue
      if (FORBIDDEN.test(readFileSync(join(srcDir, rel), "utf8"))) offenders.push(rel)
    }
    expect(offenders).toEqual([])

    // Meta-guard: the SCAN pattern must actually match a literal `Dockerfile` + a `.py` shim +
    // a `.toml` (regression tripwire — a future glob edit that drops these silently re-opens the gap).
    const g = new Bun.Glob(SCAN)
    expect(g.match("Dockerfile")).toBe(true)
    expect(g.match("sub/Dockerfile")).toBe(true)
    expect(g.match("foo/shim.py")).toBe(true)
    expect(g.match("pyproject.toml")).toBe(true)
  })
})
