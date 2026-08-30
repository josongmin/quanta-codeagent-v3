/**
 * RED→GREEN invariants for the Terminal-Bench `terminal` ToolSurface.
 *
 * AUTHORITY: TB21-06 transferred contracts TC-1 (ownership boundary) + TC-1a (spec
 * S1-S4) — `docs/plans/aug-21-bench-terminal-2-1/TB21-06-transferred-contracts.md`.
 *
 * These pin that HARD spec (S1-S4) + the ownership-boundary audit checks so a future
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
import { assertScanPopulation } from "../../tests/unit/_shared/scan-population"
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
    /**
     * aug-22 — TWO RATCHETS IN DIRECT CONFLICT, resolved by splitting the rule
     * rather than by raising a ceiling.
     *
     * BFND-02 made the persisted report a discriminated union
     * (`CanonicalBenchReport = SweBenchReport | TerminalBenchReport`) with ONE
     * writer. The runner-slice boundary forbids `@/runner` from referencing
     * `apps/**` even in TYPE position, so the Terminal branch's SHAPE had to be
     * declared DOWN in `src/runner/batch/` — which is exactly the region this
     * fence forbids Terminal naming in. One of the two rails had to give.
     *
     * The split: this fence exists to stop the Terminal-Bench INTEGRATION from
     * sprawling — the Harbor client, the `BaseAgent` Python shim, a stray
     * compose/Dockerfile. Those tokens stay forbidden EVERYWHERE outside
     * `apps/` with no exceptions (verified: zero hits in `src/` outside
     * `apps/`). What is structurally forced is only the SUITE DISCRIMINANT —
     * the type name and the `"terminal-bench"` string literal — inside the
     * canonical report union. That is data-model, not integration: it names a
     * branch, it cannot reach Harbor, and the runner still imports nothing from
     * `apps/`.
     *
     * So the exemption is enumerated, per-file, and narrow: only these three
     * modules, and only for the discriminant tokens. `Harbor`/`BaseAgent` in
     * any of them is still an offence (asserted below), and a NEW file that
     * wants in must be added here deliberately with a reason.
     *
     * NOT an inherited failure: at the session base `9d5369d31` this fence was
     * GREEN and none of these three files existed. It was first reported as
     * "pre-existing" only because a concurrent session had already committed
     * this campaign's own work into HEAD, which made a `git show HEAD:` control
     * circular.
     */
    const DISCRIMINANT_ONLY = /TerminalBench|terminal-bench/i
    const INTEGRATION_ONLY = /\bHarbor\b|\bBaseAgent\b/i
    const CANONICAL_REPORT_UNION: readonly string[] = [
      "runner/batch/report.ts",
      "runner/batch/report-envelope.ts",
      "runner/batch/report-terminal.ts",
    ]
    const scanned = [...new Bun.Glob(SCAN).scanSync(srcDir)].filter(
      (rel) => !rel.startsWith("apps/") && !isTest(rel),
    )
    assertScanPopulation(
      scanned.map((rel) => join(srcDir, rel)),
      srcDir,
      {
        id: "src/tool/terminal-surface.test.ts#SRC-NON-APPS",
        collectable: (name) =>
          name === "Dockerfile" ||
          name.endsWith(".Dockerfile") ||
          /\.(?:ts|tsx|py|sh|json|mjs|cjs|mts|cts|yaml|yml|toml|cfg|ini|txt|env)$/.test(name),
        skipDirs: ["apps", "__tests__"],
      },
    )
    const integrationOffenders: string[] = []
    for (const rel of scanned) {
      const text = readFileSync(join(srcDir, rel), "utf8")
      // The integration tokens are forbidden everywhere outside apps/ — no
      // exemption, including inside the canonical report union.
      if (INTEGRATION_ONLY.test(text)) integrationOffenders.push(rel)
      if (!FORBIDDEN.test(text)) continue
      // Discriminant naming is tolerated ONLY in the enumerated union modules.
      if (CANONICAL_REPORT_UNION.includes(rel) && !INTEGRATION_ONLY.test(text)) continue
      offenders.push(rel)
    }
    expect(integrationOffenders).toEqual([])
    expect(offenders).toEqual([])

    // Anti-vacuity: the exemption must be LIVE, not a dead list. Each enumerated
    // module must actually exist and actually carry the discriminant — otherwise
    // the carve-out is stale and should be deleted rather than kept "just in case".
    for (const rel of CANONICAL_REPORT_UNION) {
      const text = readFileSync(join(srcDir, rel), "utf8")
      expect(DISCRIMINANT_ONLY.test(text)).toBe(true)
      expect(INTEGRATION_ONLY.test(text)).toBe(false)
    }

    // Meta-guard: the SCAN pattern must actually match a literal `Dockerfile` + a `.py` shim +
    // a `.toml` (regression tripwire — a future glob edit that drops these silently re-opens the gap).
    const g = new Bun.Glob(SCAN)
    expect(g.match("Dockerfile")).toBe(true)
    expect(g.match("sub/Dockerfile")).toBe(true)
    expect(g.match("foo/shim.py")).toBe(true)
    expect(g.match("pyproject.toml")).toBe(true)
  })
})
