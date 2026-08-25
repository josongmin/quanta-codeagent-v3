/**
 * GOAL-03 hellgate — `runArgv`: exact argv, shared env/sandbox composition with
 * `runShell`, bounded kill/timeout. No shell, no join.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runArgv } from "@/runtime/run-argv"
import type { ScrubbedSpawner } from "@/runtime/scrubbed-spawn"
import { runShell } from "@/runtime/shell"

const cwd = process.cwd()

describe("GOAL-03 — runArgv", () => {
  test("spaces, quotes, semicolons and unicode stay ONE argv element (no shell interpolation)", async () => {
    const weird = `a b; echo "pwned" 'x' ; 한글 $(id)`
    const dir = mkdtempSync(join(tmpdir(), "run-argv-"))
    const script = join(dir, "printargs.ts")
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))\n")
    try {
      const res = await runArgv(["bun", script, weird, "second"], { cwd, timeoutMs: 20_000 })
      expect(res.exitCode).toBe(0)
      expect(JSON.parse(new TextDecoder().decode(res.stdout).trim())).toEqual([weird, "second"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the child env is SCRUBBED: a secret-looking parent variable never reaches the child", async () => {
    process.env.QUANTA_TEST_SECRET_LEAK = "must-not-leak"
    try {
      const res = await runArgv(
        ["bun", "-e", "console.log(String(process.env.QUANTA_TEST_SECRET_LEAK))"],
        {
          cwd,
          timeoutMs: 20_000,
        },
      )
      expect(new TextDecoder().decode(res.stdout).trim()).toBe("undefined")
    } finally {
      delete process.env.QUANTA_TEST_SECRET_LEAK
    }
  })

  test("timeout kills the child (timedOut:true) and never leaves it running", async () => {
    const started = Date.now()
    const res = await runArgv(["bun", "-e", "setTimeout(() => {}, 60_000)"], {
      cwd,
      timeoutMs: 300,
    })
    expect(res.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("abort signal kills the child (aborted:true)", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const res = await runArgv(["bun", "-e", "setTimeout(() => {}, 60_000)"], {
      cwd,
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    expect(res.aborted).toBe(true)
  })

  test("non-zero exit is reported, never thrown; the spawned argv is returned verbatim", async () => {
    const res = await runArgv(["bun", "-e", "process.exit(3)"], { cwd, timeoutMs: 20_000 })
    expect(res.exitCode).toBe(3)
    expect(res.spawnedArgv).toEqual(["bun", "-e", "process.exit(3)"])
  })

  test("per-call wrap and the sandbox status hook compose exactly like runShell (paired control)", async () => {
    // A REAL wrap layer: prefix `env VAR=1` so the child observes it. Both paths
    // must run the same layer, report the same honest status and print the same.
    const perCallWrap = async (argv: ReadonlyArray<string>) => ({
      argv: ["env", "QUANTA_WRAP_SEEN=1", ...argv],
      sandboxApplied: true,
    })
    const argvStatuses: unknown[] = []
    const viaArgv = await runArgv(["bash", "-lc", "echo wrap=$QUANTA_WRAP_SEEN"], {
      cwd,
      timeoutMs: 20_000,
      perCallWrap,
      onSandboxStatus: (s) => argvStatuses.push(s),
    })
    expect(viaArgv.spawnedArgv.slice(0, 2)).toEqual(["env", "QUANTA_WRAP_SEEN=1"])
    expect(new TextDecoder().decode(viaArgv.stdout).trim()).toBe("wrap=1")
    expect(argvStatuses).toEqual([{ applied: true }])

    const shellStatuses: unknown[] = []
    const shell = await runShell("echo wrap=$QUANTA_WRAP_SEEN", {
      cwd,
      timeoutMs: 20_000,
      perCallWrap,
      ...({ onSandboxStatus: (s: unknown) => shellStatuses.push(s) } as object),
    })
    expect(shell.stdout.trim()).toBe("wrap=1")
    expect(shellStatuses).toEqual([{ applied: true }])
  })

  test("a recorder spawner sees the scrubbed env and the wrapped argv (no raw parent env)", async () => {
    process.env.QUANTA_TEST_SECRET_LEAK = "must-not-leak"
    const seen: { argv: readonly string[]; env: Record<string, string | undefined> }[] = []
    const recorder: ScrubbedSpawner = (argv, options) => {
      seen.push({ argv, env: { ...options.env } })
      return {
        pid: 1,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        exited: Promise.resolve(0),
        kill: () => undefined,
      }
    }
    try {
      const res = await runArgv(["x", "y z"], { cwd, timeoutMs: 1_000, spawner: recorder })
      expect(res.exitCode).toBe(0)
      expect(seen[0]?.argv).toEqual(["x", "y z"])
      expect(seen[0]?.env.QUANTA_TEST_SECRET_LEAK).toBeUndefined()
    } finally {
      delete process.env.QUANTA_TEST_SECRET_LEAK
    }
  })

  test("an empty argv is a TypeError (never a bare spawn)", async () => {
    await expect(runArgv([], { cwd, timeoutMs: 1 })).rejects.toBeInstanceOf(TypeError)
  })
})
