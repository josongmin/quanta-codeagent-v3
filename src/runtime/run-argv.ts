/**
 * GOAL-03 — the argv-level composition core shared by `runShell` and the
 * objective verifier.
 *
 * `runShell(command)` builds `["bash","-lc",command]` and then needs exactly
 * what a verifier needs for an EXACT argv: the scrubbed env, the snapshot
 * restore + per-call wrap + installed sandbox slot (in that order, with the
 * honest sandbox verdict emitted once), the branded spawner, and a bounded
 * kill/timeout guard. Those pieces live HERE so both callers share ONE policy
 * (a test pins that `runShell("x")` and `runArgv(["bash","-lc","x"])` compose
 * the identical argv/env) and `shell.ts` stays below the 900-line cohort.
 *
 * `runArgv` never joins its argv and never implies a shell: an element with
 * spaces, quotes or `;` is ONE element to the child.
 */

import type { Subprocess } from "bun"
import { escalatingKill, withSpawnedChild } from "./guarded-spawn"
import { applyLocalEnv } from "./local-env"
import { withProxyEnv } from "./network-proxy"
import { defaultPpidWalkKiller } from "./process-tree"
import { DEFAULT_ENV_ALLOWLIST, SandboxUnavailableError, scrubEnv } from "./sandbox"
import {
  asScrubbedEnv,
  bunScrubbedSpawner,
  type ScrubbedEnv,
  type ScrubbedSpawner,
} from "./scrubbed-spawn"
import { getShellSandbox } from "./shell-sandbox-holder"
import type { ShellOptions } from "./types"

export type ShellSandboxStatus =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: string }

/** OPTIONAL honesty hook — invoked exactly once, BEFORE spawn, with the typed
 *  sandbox status for this call. Absent ⇒ no status computed. */
export type ShellOptionsWithSandboxStatus = ShellOptions & {
  onSandboxStatus?: (status: ShellSandboxStatus) => void
}

/** Fold a single wrap layer's `(sandboxApplied, degradeReason?)` outcome into
 *  the running status. First degradation reason wins; a later applied layer
 *  cannot un-degrade an earlier honest degradation. Pure. */
export const foldSandboxStatus = (
  prior: ShellSandboxStatus,
  layer: { readonly sandboxApplied: boolean; readonly degradeReason?: string | undefined },
): ShellSandboxStatus => {
  if (!prior.applied) return prior
  if (layer.degradeReason !== undefined) return { applied: false, reason: layer.degradeReason }
  if (layer.sandboxApplied) return { applied: true }
  return prior
}

/** Explicit restrictive CLI profiles are an enforcement contract, not a
 *  best-effort preference. `workspace-write-net` included: it promises the
 *  workspace FS fence just like `workspace-write` — only network differs. */
const requiresFullSandboxEnforcement = (profile: string): boolean =>
  profile === "read-only" || profile === "workspace-write" || profile === "workspace-write-net"

/** The one degradation a profile's own contract already absorbs: landlock-cli
 *  cannot enforce network POLICY, but `workspace-write-net` ALLOWS network —
 *  so a wrapper that did apply the FS fence lost nothing the profile promised.
 *  Never tolerated when the wrapper itself was not applied. */
const isToleratedPartialDegrade = (
  profile: string,
  wrapped: { readonly sandboxApplied: boolean; readonly degradeReason?: string | undefined },
): boolean =>
  profile === "workspace-write-net" &&
  wrapped.sandboxApplied &&
  wrapped.degradeReason === "landlock-network-policy-not-enforced"

/** Throw when a profile that PROMISES enforcement did not actually get it. */
export const assertSandboxEnforced = (
  profile: string,
  wrapped: { readonly sandboxApplied: boolean; readonly degradeReason?: string | undefined },
): void => {
  if (
    requiresFullSandboxEnforcement(profile) &&
    (!wrapped.sandboxApplied || wrapped.degradeReason !== undefined) &&
    !isToleratedPartialDegrade(profile, wrapped)
  ) {
    throw new SandboxUnavailableError(
      `QUANTA_SANDBOX=${profile} cannot be enforced: ` +
        (wrapped.degradeReason ?? "sandbox wrapper was not applied"),
    )
  }
}

/**
 * Snapshot restore → per-call wrap → installed sandbox slot, in that order, and
 * the honest sandbox verdict exactly once before the spawn. The ORDER is
 * load-bearing: the snapshot restore must happen BEFORE sandbox wrapping,
 * because a sandbox adapter prepends its own executable and a later restore
 * could no longer find the `*sh -c` command.
 */
export const wrapSandboxArgv = async (
  baseArgv: ReadonlyArray<string>,
  options: ShellOptions,
  cwd: string,
): Promise<readonly string[]> => {
  const snap = options.shellSnapshot
  const restoredArgv = snap !== undefined ? snap.restore(snap.handle, baseArgv).argv : [...baseArgv]
  const perCallWrap = options.perCallWrap
  const onSandboxStatus = (options as ShellOptionsWithSandboxStatus).onSandboxStatus
  let sandboxStatus: ShellSandboxStatus = { applied: true }
  let anyWrapLayerRan = false

  let perCallArgv: string[]
  if (perCallWrap !== undefined) {
    const wrapped = await perCallWrap(restoredArgv, cwd)
    perCallArgv = wrapped.argv
    anyWrapLayerRan = true
    if (onSandboxStatus !== undefined) sandboxStatus = foldSandboxStatus(sandboxStatus, wrapped)
  } else {
    perCallArgv = restoredArgv
  }

  const slot = getShellSandbox()
  let sandboxedArgv: string[]
  if (slot !== undefined) {
    const wrapped = await slot.wrap(perCallArgv, cwd)
    assertSandboxEnforced(slot.policy.profile, wrapped)
    sandboxedArgv = wrapped.argv
    anyWrapLayerRan = true
    if (onSandboxStatus !== undefined) sandboxStatus = foldSandboxStatus(sandboxStatus, wrapped)
  } else {
    sandboxedArgv = perCallArgv
  }

  if (onSandboxStatus !== undefined) {
    onSandboxStatus(
      anyWrapLayerRan ? sandboxStatus : { applied: false, reason: "no-sandbox-installed" },
    )
  }
  return sandboxedArgv
}

/** The scrubbed child env (ADR-0006 / ADR-0455 / ADR-0428 composition). */
export const resolveShellEnv = (options: ShellOptions): ScrubbedEnv => {
  const baseEnv =
    options.inheritEnv === true ? (process.env as Record<string, string | undefined>) : scrubEnv()
  const localEnvBase = applyLocalEnv(baseEnv, options.localEnv, DEFAULT_ENV_ALLOWLIST)
  return asScrubbedEnv(withProxyEnv(localEnvBase, options.proxyEnv ?? {}))
}

export interface RunArgvOptions {
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly perCallWrap?: ShellOptions["perCallWrap"]
  readonly localEnv?: ShellOptions["localEnv"]
  readonly proxyEnv?: ShellOptions["proxyEnv"]
  readonly onSandboxStatus?: (status: ShellSandboxStatus) => void
  /** Test seam: the spawner; production is the branded Bun spawner. */
  readonly spawner?: ScrubbedSpawner
}

export interface RunArgvResult {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  /** The argv that was actually spawned (after every wrap layer). */
  readonly spawnedArgv: readonly string[]
  readonly durationMs: number
}

/** Hard ceiling on a caller-supplied timeout: one day (24h * 3_600_000 ms) —
 *  a check that needs longer is not a verification check. */
const MAX_TIMEOUT_MS = 24 * 3_600_000
const TREE_KILLER = defaultPpidWalkKiller()

const readAll = async (stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> =>
  stream === null ? new Uint8Array() : new Uint8Array(await new Response(stream).arrayBuffer())

/**
 * Run an EXACT argv with the shared env/sandbox composition and a bounded
 * kill/timeout guard. Buffered (no observer/background seams — those stay on
 * `runShell`). Never throws on a non-zero exit; a sandbox-enforcement failure
 * still throws `SandboxUnavailableError` (the caller decides fail-closed).
 */
export const runArgv = async (
  argv: readonly string[],
  options: RunArgvOptions,
): Promise<RunArgvResult> => {
  if (argv.length === 0 || argv.some((a) => typeof a !== "string")) {
    throw new TypeError("runArgv: argv must be a non-empty string array")
  }
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, MAX_TIMEOUT_MS)
      : MAX_TIMEOUT_MS
  const shellOptions: ShellOptionsWithSandboxStatus = {
    cwd: options.cwd,
    ...(options.perCallWrap !== undefined ? { perCallWrap: options.perCallWrap } : {}),
    ...(options.localEnv !== undefined ? { localEnv: options.localEnv } : {}),
    ...(options.proxyEnv !== undefined ? { proxyEnv: options.proxyEnv } : {}),
    ...(options.onSandboxStatus !== undefined ? { onSandboxStatus: options.onSandboxStatus } : {}),
  }
  const env = resolveShellEnv(shellOptions)
  const spawnedArgv = await wrapSandboxArgv(argv, shellOptions, options.cwd)
  const startedAt = Date.now()
  const proc = (options.spawner ?? bunScrubbedSpawner)(spawnedArgv, {
    cwd: options.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  }) as Subprocess<"ignore", "pipe", "pipe">

  let timedOut = false
  let aborted = false
  const { kill, disarm } = escalatingKill(proc, TREE_KILLER)
  const onAbort = (): void => {
    aborted = true
    kill()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutMs)

  return withSpawnedChild(
    {
      kill,
      timer,
      cleanup: () => {
        disarm()
        options.signal?.removeEventListener("abort", onAbort)
      },
    },
    async () => {
      const [stdout, stderr] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr)])
      const exitCode = await proc.exited
      return {
        stdout,
        stderr,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        timedOut,
        aborted,
        spawnedArgv,
        durationMs: Date.now() - startedAt,
      }
    },
  )
}
