/**
 * G3-02 / G5-01 — the Bun.spawn exec-helper clone family must carry BOTH
 * hardenings the canonical `runner/batch/eval/exec.ts` got:
 *
 *   1. jun-26 tree-kill: the deadline must reap the whole process TREE
 *      (`bash -c` → children → grandchildren). A bare `proc.kill()` signals
 *      only the root, a surviving child holds the stdout pipe open, and the
 *      `.text()` await HANGS past the deadline (docker/pytest trees outlive
 *      the budget).
 *   2. C9 env scrub: children get the `scrubEnv()` allowlist, never raw
 *      `process.env` — the parent's `OPENAI_API_KEY`/tokens must NOT be
 *      inherited by bench child processes.
 *
 * The stale copies this hellgate pins: `runner/batch/corpus/dataset.ts`
 * (`defaultExec`), `apps/bench/python-swebench.ts` (`defaultSpawn`),
 * `apps/bench/harness/prepare.ts` (`defaultSpawn`), `apps/bench/harness/
 * images.ts` (`defaultDockerSpawn`), and `tool/gh/runner.ts`
 * (`defaultGhRunner` — env already scrubbed, kill still bare).
 *
 * Layers:
 *   - BEHAVIORAL (exported helpers): a planted secret-like env var must not
 *     reach the child; a timed-out command's grandchild must actually die.
 *     Real processes on purpose — a fake child cannot hold a pipe open.
 *   - PRODUCER-SIDE source guard (all five files): no `env: process.env` at a
 *     spawn site and no bare `setTimeout(() => proc.kill(), …)` deadline —
 *     covers the two helpers that are not exported / need a docker daemon.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultSpawn as pySwebenchDefaultSpawn } from "@/apps/bench/python-swebench"
import { defaultExec as datasetDefaultExec } from "@/runner/batch/corpus/dataset"
import { defaultGhRunner } from "@/tool/gh/runner"

const SRC = join(import.meta.dir, "..", "..", "src")
const scratch = mkdtempSync(join(tmpdir(), "spawn-consolidation-hellgate-"))

/** Planted secret-like name: matches nothing on any env allowlist, so a
 *  scrubbed child must NOT see it; an `env: process.env` child WILL. */
const PLANTED = "QUANTA_HELLGATE_PLANTED_SECRET"
process.env[PLANTED] = "leak-me"

afterAll(() => {
  delete process.env[PLANTED]
  rmSync(scratch, { recursive: true, force: true })
})

/** Is `pid` still alive? `kill(pid, 0)` delivers no signal; it only probes. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll until `pid` is dead or the budget elapses — SIGTERM delivery/reap is
 *  asynchronous, so a single fixed sleep is a load-sensitive flake. The budget
 *  (3s) sits above the SIGKILL escalation grace and far below the grandchild's
 *  8s sleep, so a bare root-only kill still reads as alive. */
const diedWithin = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await Bun.sleep(100)
  }
  return !alive(pid)
}

/** Root bash → backgrounded `bash -c` subshell (grandchild writes its pid,
 *  then sleeps). A root-only kill leaves the grandchild holding the stdout
 *  pipe, so the caller's `.text()` await outlives the deadline by seconds. */
const grandchildCmd = (pidFile: string): string =>
  `bash -c 'echo $$ > ${pidFile}; sleep 8' & sleep 8`

describe("G3-02 — child env is scrubbed (planted secret never inherited)", () => {
  test("corpus/dataset.ts defaultExec: the planted secret is NOT visible to the child", async () => {
    const r = await datasetDefaultExec(`printenv ${PLANTED}`, scratch, 15_000)
    expect(r.stdout.trim(), "planted secret leaked into the bash child env").not.toBe("leak-me")
    // PAIRED CONTROL — the child env is scrubbed, not emptied/broken.
    const path = await datasetDefaultExec("printenv PATH", scratch, 15_000)
    expect(path.code).toBe(0)
    expect(path.stdout.trim().length).toBeGreaterThan(0)
  }, 30_000)

  test("python-swebench.ts defaultSpawn: the planted secret is NOT visible to the child", async () => {
    const r = await pySwebenchDefaultSpawn(["printenv", PLANTED], scratch, 15_000)
    expect(r.stdout.trim(), "planted secret leaked into the argv child env").not.toBe("leak-me")
    // PAIRED CONTROL.
    const path = await pySwebenchDefaultSpawn(["printenv", "PATH"], scratch, 15_000)
    expect(path.code).toBe(0)
    expect(path.stdout.trim().length).toBeGreaterThan(0)
  }, 30_000)
})

describe("G3-02 — the deadline tree-kills (grandchild reaped, no pipe hang)", () => {
  test("corpus/dataset.ts defaultExec: a timed-out command's grandchild dies and exec returns", async () => {
    const pidFile = join(scratch, "dataset-grandchild.pid")
    const started = Date.now()
    const result = await datasetDefaultExec(grandchildCmd(pidFile), scratch, 400)
    const elapsed = Date.now() - started
    // Returned promptly — the pipe was released, not held for the full sleep.
    expect(elapsed, "exec outlived its deadline (pipe held by surviving child)").toBeLessThan(5_000)
    expect(result).toHaveProperty("code")
    const grandchild = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    expect(grandchild).toBeGreaterThan(0)
    expect(
      await diedWithin(grandchild, 3_000),
      `grandchild ${grandchild} survived the deadline`,
    ).toBe(true)
  }, 30_000)

  test("tool/gh/runner.ts defaultGhRunner: a timed-out command's grandchild dies and the runner returns", async () => {
    const pidFile = join(scratch, "gh-grandchild.pid")
    const started = Date.now()
    const result = await defaultGhRunner(["bash", "-c", grandchildCmd(pidFile)], scratch, 400)
    const elapsed = Date.now() - started
    expect(elapsed, "runner outlived its deadline (pipe held by surviving child)").toBeLessThan(
      5_000,
    )
    expect(result).toHaveProperty("code")
    const grandchild = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    expect(grandchild).toBeGreaterThan(0)
    expect(
      await diedWithin(grandchild, 3_000),
      `grandchild ${grandchild} survived the deadline`,
    ).toBe(true)
  }, 30_000)

  // PAIRED CONTROL — a command that finishes inside its deadline is untouched.
  test("a fast command completes normally under both helpers", async () => {
    const a = await datasetDefaultExec("echo consolidation-control", scratch, 20_000)
    expect(a.code).toBe(0)
    expect(a.stdout.trim()).toBe("consolidation-control")
    const b = await defaultGhRunner(["echo", "consolidation-control"], scratch, 20_000)
    expect(b.code).toBe(0)
    expect(b.stdout.trim()).toBe("consolidation-control")
  }, 30_000)
})

describe("G3-02 — producer-side guard: the clone family sites carry no stale spawn shape", () => {
  /** The five files the finding names. Missing file ⇒ readFileSync throws
   *  (fail-closed: a rename must update this pin, not silently drop coverage). */
  const FILES = [
    "runner/batch/corpus/dataset.ts",
    "apps/bench/python-swebench.ts",
    "apps/bench/harness/prepare.ts",
    "apps/bench/harness/images.ts",
    "tool/gh/runner.ts",
  ] as const

  /** Code lines only — a comment recording the old shape must not flag. */
  const codeLines = (text: string): string[] =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))

  test("no spawn site passes raw `env: process.env` to a child", () => {
    for (const rel of FILES) {
      const offending = codeLines(readFileSync(join(SRC, rel), "utf8")).filter((l) =>
        /env:\s*process\.env\b/.test(l),
      )
      expect(offending, `${rel} still hands the raw parent env to a child`).toEqual([])
    }
  })

  test("no spawn site arms a bare single-PID `proc.kill()` deadline", () => {
    for (const rel of FILES) {
      const offending = codeLines(readFileSync(join(SRC, rel), "utf8")).filter((l) =>
        /setTimeout\(\(\)\s*=>\s*proc\.kill\(\)/.test(l),
      )
      expect(offending, `${rel} still tree-leaks on timeout (bare proc.kill deadline)`).toEqual([])
    }
  })

  test("anti-vacuity: every pinned file delegates to (or arms) the hardened kill/scrub path", () => {
    for (const rel of FILES) {
      const text = readFileSync(join(SRC, rel), "utf8")
      const hardened = /from\s+["'][^"']*eval\/exec["']/.test(text) || /escalatingKill/.test(text)
      expect(hardened, `${rel} neither imports the canonical exec nor escalatingKill`).toBe(true)
    }
  })
})
