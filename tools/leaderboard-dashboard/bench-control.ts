/**
 * Benchmark CONTROL service (RFC jun-29 — SOTA++ platform management console).
 *
 * The framework-agnostic layer between the dashboard's HTTP routes and the bench CLI: it owns
 * process spawning, a registry of in-flight launches, log tailing, and box queries. It depends
 * ONLY on {@link ./bench-actions} (the validated argv builder) + node `child_process`/`fs` —
 * NOT on Bun.serve or any HTTP framework — so the whole "benchmark control plane" (actions +
 * control) is a self-contained unit that can later be extracted into its own service/daemon
 * without touching the dashboard UI. The server.ts routes are a THIN adapter over this class.
 *
 * Injectable `spawn`/`now` keep it unit-testable with zero real processes.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process"
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  ActionError,
  buildBoxLsAction,
  buildBoxRmAction,
  buildBoxStatusAction,
  buildLaunchAction,
  type LaunchSpec,
} from "./bench-actions"

/** A spawn shim — (cmd, argv, opts) → a child with stdout/stderr streams + exit. The default is
 *  node:child_process.spawn; tests inject a fake. Kept minimal so it's trivial to stub. */
export type SpawnFn = (
  cmd: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean },
) => ChildProcess

export interface LaunchInfo {
  launchId: string
  pid: number
  family: string
  dataset: string
  preset: string
  startedAt: number
  logPath: string
  status: "running" | "exited"
  exitCode?: number
}

export interface BenchControlDeps {
  repoDir: string
  runDir: string // where per-launch logs live (created if absent)
  cmd?: string // the runtime to spawn (default "bun")
  spawn?: SpawnFn
  now?: () => number
  /** Live preset allowlist (knob-catalog keys) — a launch preset MUST be in it. */
  validPresets: () => ReadonlySet<string>
  /** Max concurrent RUNNING launches — each launch provisions EC2 boxes ($), so an
   *  unbounded /api/launch loop is a real cost-DoS. Default 2. */
  maxConcurrent?: number
  /** Per-launch log byte cap — a chatty/looping run must not fill the disk. Default 64MB. */
  maxLogBytes?: number
  /** Timeout (ms) for short-lived box queries (box ls/status/rm) so a hung AWS CLI can't
   *  wedge a handler / leak a child. Default 60s. */
  queryTimeoutMs?: number
}

/** Run a short-lived CLI command to completion, capturing stdout. Rejects on non-zero unless
 *  `tolerateNonZero`. Used for box ls/status/rm (fast, JSON-emitting). */
const collect = (
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let done = false
    const finish = (r: { code: number; stdout: string; stderr: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    // M1: a hung AWS CLI must not wedge the handler forever — kill + resolve on timeout.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      finish({
        code: 124,
        stdout,
        stderr: `${stderr}\n[bench-control] query timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    child.stdout?.on("data", (d) => {
      stdout += String(d)
    })
    child.stderr?.on("data", (d) => {
      stderr += String(d)
    })
    child.on("close", (code) => finish({ code: code ?? 0, stdout, stderr }))
    child.on("error", (e) => finish({ code: 1, stdout, stderr: `${stderr}${String(e)}` }))
  })

export class BenchControl {
  private readonly deps: Required<Omit<BenchControlDeps, "validPresets">> & {
    validPresets: () => ReadonlySet<string>
  }
  private readonly launches = new Map<
    string,
    LaunchInfo & { child?: ChildProcess | undefined; logBytes?: number }
  >()
  private seq = 0

  constructor(deps: BenchControlDeps) {
    this.deps = {
      repoDir: deps.repoDir,
      runDir: deps.runDir,
      cmd: deps.cmd ?? "bun",
      spawn: deps.spawn ?? (nodeSpawn as unknown as SpawnFn),
      now: deps.now ?? (() => Date.now()),
      validPresets: deps.validPresets,
      maxConcurrent: deps.maxConcurrent ?? 2,
      maxLogBytes: deps.maxLogBytes ?? 64 * 1024 * 1024,
      queryTimeoutMs: deps.queryTimeoutMs ?? 60_000,
    }
    try {
      // 0700: run logs carry the grade's stdout (inherits creds-bearing env) — keep them
      // out of reach of other local users under world-traversable /tmp (round-3 audit #5).
      mkdirSync(this.deps.runDir, { recursive: true, mode: 0o700 })
    } catch {
      // best-effort; a launch will surface the real error if the dir is unwritable
    }
  }

  /** Cap the launch registry: drop the OLDEST exited entries past `MAX_LAUNCHES` so the Map +
   *  retained ChildProcess refs don't grow unbounded over the dashboard's lifetime (audit #3). */
  private evictOldLaunches(): void {
    const MAX = 50
    if (this.launches.size <= MAX) return
    const exited = [...this.launches.entries()]
      .filter(([, i]) => i.status === "exited")
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
    for (const [id] of exited.slice(0, this.launches.size - MAX)) this.launches.delete(id)
  }

  /** Launch a supervised full-remote grade for `spec`. Detached so it survives a dashboard
   *  restart; stdout/stderr → a per-launch log the UI tails. Throws ActionError on bad input
   *  (the route maps to 400) BEFORE any spawn. Returns the registry entry. */
  launch(spec: LaunchSpec): LaunchInfo {
    const { argv, env } = buildLaunchAction(spec, this.deps.validPresets()) // validates or throws
    // C2: cap concurrent RUNNING launches — each provisions EC2 boxes ($). An /api/launch loop
    // or double-click must NOT spawn an unbounded fleet. Count live ones; refuse past the cap.
    const running = [...this.launches.values()].filter(
      (i) => i.status === "running" && i.pid > 0 && this.isAlive(i.pid),
    ).length
    if (running >= this.deps.maxConcurrent) {
      throw new ActionError(
        `too many concurrent launches (${running}/${this.deps.maxConcurrent}) — stop one before starting another`,
      )
    }
    const launchId = `launch-${this.deps.now()}-${++this.seq}`
    const logPath = join(this.deps.runDir, `${launchId}.log`)
    const child = this.deps.spawn(this.deps.cmd, argv, {
      cwd: this.deps.repoDir,
      env: { ...process.env, ...env },
      detached: true,
    })
    const info: LaunchInfo & { child?: ChildProcess | undefined; logBytes?: number } = {
      launchId,
      pid: child.pid ?? -1,
      family: spec.family,
      dataset: spec.dataset,
      preset: spec.preset,
      startedAt: this.deps.now(),
      logPath,
      status: "running",
      child,
      logBytes: 0,
    }
    child.stdout?.on("data", (d) => this.appendLog(info, String(d)))
    child.stderr?.on("data", (d) => this.appendLog(info, String(d)))
    child.on("close", (code) => {
      info.status = "exited"
      info.exitCode = code ?? 0
      info.child = undefined // release the ChildProcess (+ its stream buffers) on exit (audit #3)
    })
    child.unref?.()
    this.launches.set(launchId, info)
    this.evictOldLaunches()
    return this.publicInfo(info)
  }

  private appendLog(info: LaunchInfo & { logBytes?: number }, chunk: string): void {
    // H2: bound per-launch log bytes so a chatty/looping grade can't exhaust the disk.
    const written = info.logBytes ?? 0
    if (written >= this.deps.maxLogBytes) return // capped — drop further output
    const room = this.deps.maxLogBytes - written
    const slice =
      chunk.length > room ? `${chunk.slice(0, room)}\n[bench-control] log capped\n` : chunk
    try {
      appendFileSync(info.logPath, slice, { mode: 0o600 }) // 0600: secret-bearing log, owner-only
      info.logBytes = written + slice.length
    } catch {
      // a full disk / unlink mid-run must not crash the dashboard
    }
  }

  private publicInfo(
    i: LaunchInfo & { child?: ChildProcess | undefined; logBytes?: number },
  ): LaunchInfo {
    const { child: _child, logBytes: _logBytes, ...rest } = i
    return { ...rest }
  }

  /** Registry snapshot (process-liveness refreshed via kill(pid,0)). */
  listLaunches(): LaunchInfo[] {
    return [...this.launches.values()].map((i) => {
      if (i.status === "running" && i.pid > 0 && !this.isAlive(i.pid)) {
        i.status = "exited"
      }
      return this.publicInfo(i)
    })
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Read the TAIL of a launch's log (for the console widget). Reads only the trailing
   *  `maxBytes` window via seek — NOT the whole file (round-3 audit: a 64MB-capped log loaded
   *  fully every 3s poll × N tabs is self-inflicted memory pressure). */
  readLaunchLog(launchId: string, maxBytes = 65536): string {
    const info = this.launches.get(launchId)
    if (info === undefined) throw new ActionError(`unknown launch: ${launchId}`)
    let fd: number | undefined
    try {
      const size = statSync(info.logPath).size
      const start = Math.max(0, size - maxBytes)
      const len = size - start
      if (len <= 0) return ""
      fd = openSync(info.logPath, "r")
      const buf = Buffer.allocUnsafe(len)
      readSync(fd, buf, 0, len, start)
      return buf.toString("utf8")
    } catch {
      return ""
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  /** `box ls --json` → parsed. */
  async listBoxes(): Promise<unknown> {
    return this.queryJson(buildBoxLsAction())
  }

  /** `box status --json` → parsed. */
  async boxStatus(): Promise<unknown> {
    return this.queryJson(buildBoxStatusAction())
  }

  /** Terminate ONE box (validated iid; never 'all' from the web). */
  async stopBox(iid: string): Promise<{ ok: boolean; output: string }> {
    const argv = buildBoxRmAction(iid) // validates or throws
    const r = await collect(this.spawnQuery(argv), this.deps.queryTimeoutMs)
    return { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.slice(-4000) }
  }

  private async queryJson(argv: string[]): Promise<unknown> {
    const r = await collect(this.spawnQuery(argv), this.deps.queryTimeoutMs)
    try {
      return JSON.parse(r.stdout)
    } catch {
      return { error: "non-json output", code: r.code, tail: `${r.stdout}${r.stderr}`.slice(-2000) }
    }
  }

  private spawnQuery(argv: string[]): ChildProcess {
    return this.deps.spawn(this.deps.cmd, argv, {
      cwd: this.deps.repoDir,
      env: { ...process.env },
    })
  }
}
