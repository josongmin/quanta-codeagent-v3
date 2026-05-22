/**
 * T2 — Patch sanitizer prune-at-source via pathspec SSOT.
 *
 * Pin the cross-module contract: the bench runner's `withGitSnapshot` MUST
 * exclude build/cache-shaped paths at the git layer so they never reach the
 * captured patch (the prior post-hoc filter let mixed source+cache patches
 * through; django run, 2026-05-21 — turns=0 abort). The failure classifier's
 * `dirty_cache_leak` signal is now an INVARIANT ALARM, not a normal path —
 * if it fires under normal operation the upstream prune was bypassed.
 *
 * SSOT invariants:
 *   - `cache-pathspecs.ts` is the only place that lists cache directory
 *     names; `runner.ts` and `failure-classifier.ts` both import from it.
 *   - `.claude/worktrees/` (the missing entry that caused the django leak)
 *     MUST appear in the SSOT list.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  CACHE_PATH_RE,
  CACHE_PATHSPECS,
  DEFAULT_CACHE_DIR_NAMES,
  getCachePathRe,
  getCachePathspecs,
} from "@/../src/apps/bench/corpus/cache-pathspecs"
import { classify } from "@/../src/apps/bench/corpus/failure-classifier"
import type { InstanceResult } from "@/../src/apps/bench/types"
import { __resetRuntimeConfig } from "@/shared"

/** Repo root, derived from this test file's path (tests/unit/…). */
const REPO_ROOT = resolve(import.meta.dir, "..", "..")

/** Stage a set of files in a temp git repo, then call the SUT path-prune
 *  helper via the bench runner's public surface. We exercise the helper end
 *  to end (`git init` → `git add` → diff capture) so we test the actual
 *  pathspec syntax against a real git binary, not a mock. */
const stageFiles = async (
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "bench-prune-"))
  for (const f of files) {
    const full = join(dir, f.path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, f.content)
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Invoke `git init` + the prune-aware diff via the same shell shape the
 *  runner uses. We avoid importing private helpers by spawning git ourselves
 *  with the SSOT pathspecs — the contract under test IS that those pathspecs
 *  exclude the noise paths. */
const captureDiff = async (dir: string): Promise<string> => {
  const sh = async (argv: string[]): Promise<{ code: number; stdout: string }> => {
    const p = Bun.spawn(argv, { cwd: dir, stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(p.stdout).text()
    const code = await p.exited
    return { code, stdout }
  }
  await sh(["git", "init", "-q"])
  await sh([
    "git",
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "base",
  ])
  await sh(["git", "add", "-A"])
  const diff = await sh(["git", "diff", "--cached", "--no-color", "--", ".", ...CACHE_PATHSPECS])
  return diff.stdout
}

describe("cache-pathspecs — SSOT contents", () => {
  test("CACHE_PATHSPECS includes .claude/worktrees/ (the django leak fix)", () => {
    const joined = CACHE_PATHSPECS.join(" ")
    expect(joined).toContain(".claude/worktrees/")
  })

  test("CACHE_PATHSPECS uses the `:(exclude,top)` pathspec magic", () => {
    for (const p of CACHE_PATHSPECS) {
      expect(p.startsWith(":(exclude,top)")).toBe(true)
    }
  })

  test("CACHE_PATH_RE matches build/cache-shaped paths it claims to cover", () => {
    expect(CACHE_PATH_RE.test("outputs/foo")).toBe(true)
    expect(CACHE_PATH_RE.test("a/b/__pycache__/c.pyc")).toBe(true)
    expect(CACHE_PATH_RE.test(".claude/worktrees/agent-abc/bar")).toBe(true)
    expect(CACHE_PATH_RE.test("node_modules/x/y.js")).toBe(true)
    // Source paths must NOT match (segment-boundary guard).
    expect(CACHE_PATH_RE.test("src/foo.py")).toBe(false)
    expect(CACHE_PATH_RE.test("my_outputs_pkg/foo.py")).toBe(false)
  })
})

describe("prune-at-source — git layer excludes cache paths", () => {
  test("mixed source + cache stage → diff contains src/, not cache paths", async () => {
    const { dir, cleanup } = await stageFiles([
      { path: "src/foo.py", content: "def f():\n    return 1\n" },
      { path: "outputs/x/y.txt", content: "leak\n" },
      { path: ".claude/worktrees/agent-abc/bar", content: "ignored\n" },
      { path: "__pycache__/baz.pyc", content: "bytecode\n" },
    ])
    try {
      const diff = await captureDiff(dir)
      expect(diff).toContain("src/foo.py")
      expect(diff).not.toContain("outputs/x/y.txt")
      expect(diff).not.toContain(".claude/worktrees/agent-abc/bar")
      expect(diff).not.toContain("__pycache__/baz.pyc")
    } finally {
      await cleanup()
    }
  })

  test("only-cache stage → empty diff (NOT cache pollution)", async () => {
    const { dir, cleanup } = await stageFiles([{ path: "outputs/x.txt", content: "only-leak\n" }])
    try {
      const diff = await captureDiff(dir)
      expect(diff.trim()).toBe("")
    } finally {
      await cleanup()
    }
  })
})

describe("SSOT — eval/snapshot.ts and corpus/failure-classifier.ts import from cache-pathspecs.ts", () => {
  test("eval/snapshot.ts imports cache pathspecs from ../corpus/cache-pathspecs (const or fn form)", () => {
    const src = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/snapshot.ts"), "utf8")
    expect(src).toMatch(
      /import\s+\{\s*(?:CACHE_PATHSPECS|getCachePathspecs)\s*\}\s+from\s+["']\.\.\/corpus\/cache-pathspecs["']/,
    )
  })

  test("corpus/failure-classifier.ts imports cache path RE from ./cache-pathspecs (const or fn form)", () => {
    const src = readFileSync(join(REPO_ROOT, "src/apps/bench/corpus/failure-classifier.ts"), "utf8")
    expect(src).toMatch(
      /import\s+\{\s*(?:CACHE_PATH_RE|getCachePathRe)\s*\}\s+from\s+["']\.\/cache-pathspecs["']/,
    )
  })

  test("corpus/failure-classifier.ts no longer defines its own CACHE_PATH_RE locally", () => {
    const src = readFileSync(join(REPO_ROOT, "src/apps/bench/corpus/failure-classifier.ts"), "utf8")
    // No `const CACHE_PATH_RE =` (local declaration) — only the import.
    expect(src).not.toMatch(/const\s+CACHE_PATH_RE\s*=/)
  })

  test("SSOT file exists at the documented location", () => {
    expect(existsSync(join(REPO_ROOT, "src/apps/bench/corpus/cache-pathspecs.ts"))).toBe(true)
  })
})

describe("env-extension — QUANTA_BENCH_CACHE_PATHSPECS_EXTRA merges with defaults", () => {
  const SAVED = process.env.QUANTA_BENCH_CACHE_PATHSPECS_EXTRA
  const reset = (): void => {
    if (SAVED === undefined) delete process.env.QUANTA_BENCH_CACHE_PATHSPECS_EXTRA
    else process.env.QUANTA_BENCH_CACHE_PATHSPECS_EXTRA = SAVED
    __resetRuntimeConfig()
  }

  test("no env ⇒ defaults only", () => {
    delete process.env.QUANTA_BENCH_CACHE_PATHSPECS_EXTRA
    __resetRuntimeConfig()
    const ps = getCachePathspecs()
    expect(ps.length).toBe(DEFAULT_CACHE_DIR_NAMES.length)
    expect(ps).toContain(":(exclude,top).claude/worktrees/")
    reset()
  })

  test("env extras append (defaults preserved, deduped)", () => {
    process.env.QUANTA_BENCH_CACHE_PATHSPECS_EXTRA = "target,vendor:outputs"
    __resetRuntimeConfig()
    const ps = getCachePathspecs()
    // defaults intact
    expect(ps).toContain(":(exclude,top)outputs/") // dedup: not duplicated
    expect(ps).toContain(":(exclude,top)__pycache__/")
    // extras appended
    expect(ps).toContain(":(exclude,top)target/")
    expect(ps).toContain(":(exclude,top)vendor/")
    // length = defaults + 2 net new (outputs collides with default)
    expect(ps.length).toBe(DEFAULT_CACHE_DIR_NAMES.length + 2)
    reset()
  })

  test("env extras propagate into CACHE_PATH_RE", () => {
    process.env.QUANTA_BENCH_CACHE_PATHSPECS_EXTRA = "target"
    __resetRuntimeConfig()
    const re = getCachePathRe()
    expect(re.test("target/debug/foo")).toBe(true)
    expect(re.test("a/b/target/x")).toBe(true)
    expect(re.test("__pycache__/x")).toBe(true) // default still works
    reset()
  })
})

describe("classifier invariant — dirty_cache_leak is silent on a properly pruned patch", () => {
  test("empty patch → no spurious dirty_cache_leak signal", () => {
    const r: InstanceResult = { id: "x", passed: false, patch: "", turns: 0 }
    expect(classify(r).signals).not.toContain("dirty_cache_leak")
  })

  test("source-only patch (post-prune shape) → no dirty_cache_leak signal", () => {
    const patch = ["diff --git a/src/real.py b/src/real.py", "@@ -1 +1 @@", "-old", "+new"].join(
      "\n",
    )
    const r: InstanceResult = { id: "x", passed: false, patch, turns: 1 }
    expect(classify(r).signals).not.toContain("dirty_cache_leak")
  })

  test("INVARIANT ALARM still fires when an all-cache patch sneaks through", () => {
    // If T2's prune-at-source is ever bypassed and an all-cache patch reaches
    // the classifier, the alarm must STILL fire — that is its post-T2 role.
    const patch = [
      "diff --git a/.claude/worktrees/agent-abc/x b/.claude/worktrees/agent-abc/x",
      "+leak",
    ].join("\n")
    const r: InstanceResult = { id: "x", passed: false, patch, turns: 0 }
    expect(classify(r).signals).toContain("dirty_cache_leak")
  })
})
