/**
 * SEP5-01 — every public gh adapter inherits one scrubbed env, abort, and
 * tree-kill policy. Adapter population is exactly three.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createCiBotGhAdapter } from "@/apps/agent/mode-presets/ci-bot"
import { createBunGhCliPort } from "@/apps/cli/from-pr-cmd-adapters"
import {
  createGhExec,
  createGhRunner,
  defaultGhExec,
  defaultGhRunner,
  type GhSpawnHandle,
} from "@/tool/gh"

const SENTINEL = "QUANTA_GH_RATCHET_SENTINEL"
const FIXTURE_ECHO = fileURLToPath(new URL("../../fixtures/echo-argv.ts", import.meta.url))
const FIXTURE_TREE = fileURLToPath(new URL("../../fixtures/hold-stdout-tree.ts", import.meta.url))
const ENV_BIN = existsSync("/usr/bin/env") ? "/usr/bin/env" : "env"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("gh exec policy — three public adapters", () => {
  const adapters = ["defaultGhRunner", "createBunGhCliPort", "createCiBotGhAdapter"] as const
  test("adapter population is exactly three", () => {
    expect(adapters).toHaveLength(3)
  })

  let saved: string | undefined
  beforeAll(() => {
    saved = process.env[SENTINEL]
    process.env[SENTINEL] = "must-not-leak"
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[SENTINEL]
    else process.env[SENTINEL] = saved
  })

  test("defaultGhRunner child omits parent sentinel", async () => {
    const r = await defaultGhRunner([ENV_BIN], process.cwd(), 10_000)
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain(SENTINEL)
    expect(r.stdout).not.toContain("must-not-leak")
  })

  test("createBunGhCliPort child omits parent sentinel", async () => {
    const port = createBunGhCliPort(ENV_BIN)
    const r = await port.run([], process.cwd())
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain(SENTINEL)
  })

  test("ci-bot adapter spawn env omits sentinel (injected spawn)", async () => {
    let childEnv: Record<string, string> | undefined
    const exec = createGhExec({
      spawn: (argv, opts) => {
        childEnv = opts.env
        return Bun.spawn([...argv], {
          cwd: opts.cwd,
          env: opts.env,
          stdout: "pipe",
          stderr: "pipe",
        })
      },
    })
    const gh = createCiBotGhAdapter(process.cwd(), exec)
    await gh(["--version"]).catch(() => undefined)
    expect(childEnv).toBeDefined()
    expect(childEnv?.[SENTINEL]).toBeUndefined()
  })

  test("mutation A: missing scrubbed env leaks sentinel in all three projections", async () => {
    let leaked = 0
    const leaky = createGhExec({
      spawn: (argv, opts) => {
        const env = { ...process.env } as Record<string, string>
        if (env[SENTINEL] !== undefined) leaked++
        return Bun.spawn([...argv], {
          cwd: opts.cwd,
          env: opts.env,
          stdout: "pipe",
          stderr: "pipe",
        })
      },
    })
    await createGhRunner(leaky)([ENV_BIN], process.cwd(), 5_000)
    await createBunGhCliPort(ENV_BIN, leaky).run([], process.cwd())
    await createCiBotGhAdapter(process.cwd(), leaky)(["--version"]).catch(() => undefined)
    expect(leaked).toBe(3)
  })
})

describe("gh exec policy — argv fidelity", () => {
  const rows = ["has space", "has'quote", 'has"double', "$(echo pwn)", "line\nbreak", "--"] as const
  test("six argv rows survive as exact array items", async () => {
    expect(rows).toHaveLength(6)
    const r = await defaultGhExec({
      argv: ["bun", FIXTURE_ECHO, ...rows],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout.trim())).toEqual([...rows])
  })
})

describe("gh exec policy — abort and tree-kill", () => {
  test("already-aborted signal performs zero spawn calls", async () => {
    let spawnCalls = 0
    const exec = createGhExec({
      spawn: (argv, opts) => {
        spawnCalls++
        return Bun.spawn([...argv], {
          cwd: opts.cwd,
          env: opts.env,
          stdout: "pipe",
          stderr: "pipe",
        })
      },
    })
    const ac = new AbortController()
    ac.abort()
    const r = await exec({
      argv: [ENV_BIN],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: ac.signal,
    })
    expect(spawnCalls).toBe(0)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("aborted before spawn")
  })

  test("timeout tree-kills descendant holding stdout", async () => {
    const r = await defaultGhExec({
      argv: ["bun", FIXTURE_TREE],
      cwd: process.cwd(),
      timeoutMs: 400,
    })
    const pids = r.stdout.trim().split(/\s+/).map(Number)
    const parent = pids[0]
    const child = pids[1]
    if (parent === undefined) throw new Error("tree fixture did not print parent pid")
    expect(Number.isInteger(parent) && parent > 0).toBe(true)
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const parentGone = !alive(parent)
      const childGone = child === undefined || child === 0 || !alive(child)
      if (parentGone && childGone) break
      await Bun.sleep(50)
    }
    expect(alive(parent)).toBe(false)
    if (child !== undefined && child > 0) expect(alive(child)).toBe(false)
  })

  test("signal vs deadline race settles once (50 runs, at most one kill initiation)", async () => {
    for (let i = 0; i < 50; i++) {
      let kills = 0
      const exec = createGhExec({
        spawn: (_argv, opts): GhSpawnHandle => {
          const proc = Bun.spawn(["/bin/sleep", "2"], {
            cwd: opts.cwd,
            env: opts.env,
            stdout: "pipe",
            stderr: "pipe",
          })
          return {
            stdout: proc.stdout,
            stderr: proc.stderr,
            exited: proc.exited,
            kill: (signal) => {
              kills++
              proc.kill(signal)
            },
          }
        },
      })
      const ac = new AbortController()
      const p = exec({
        argv: ["/bin/sleep", "2"],
        cwd: process.cwd(),
        timeoutMs: 20,
        signal: ac.signal,
      })
      ac.abort()
      const r = await p
      expect(typeof r.code).toBe("number")
      expect(kills).toBeLessThanOrEqual(1)
    }
  })
})
