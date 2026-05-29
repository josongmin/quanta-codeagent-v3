/**
 * Linux OS sandbox composer (ADR-0159 — backend dispatch over bubblewrap +
 * landlock-cli; auto-detection; OsSandbox port impl). The pure compiler
 * helpers live in `./bubblewrap.ts` and `./landlock-cli.ts`; this file
 * stitches them into the {@link OsSandbox} surface that `default.ts` returns
 * on Linux.
 *
 * Design:
 *   - `compileLinuxSandboxArgv` is the small backend-dispatch wrapper. Tests
 *     drive it as a pure function (no I/O), passing the chosen backend
 *     explicitly.
 *   - `detectLinuxSandboxBackend` queries `which` for `bwrap` first, then
 *     `landlock-cli`. Bubblewrap wins because it gives a strictly stronger
 *     fence (net + FS + namespaces vs Landlock's FS-only).
 *   - `linuxOsSandbox` is the assembled adapter: auto-detect → compile →
 *     spawn via the matching helper (`spawnViaBubblewrap` /
 *     `spawnViaLandlock`).
 *
 * Default-OFF / graceful degrade: profile="off"/"danger-full-access" returns
 * passthrough; no backend available returns degraded passthrough with a
 * typed `degradeReason`.
 */

import { errMessage } from "@/shared"
import { compileBubblewrapArgs } from "./bubblewrap"
import { spawnViaBubblewrap } from "./landlock"
import { compileLandlockCliArgs, LANDLOCK_CLI_NETWORK_DEFERRED_MARKER } from "./landlock-cli"
import type {
  OsSandbox,
  OsSandboxConfig,
  SandboxAvailability,
  SandboxedSpawnResult,
  SandboxedSpawnSpec,
  SandboxPolicy,
  Spawner,
} from "./types"
export type LinuxSandboxBackend = "bubblewrap" | "landlock-cli"

/** Compile a {@link SandboxPolicy} to the backend-specific argv. Pure. Returns
 *  an EMPTY array for profiles the caller should NOT sandbox at all
 *  (`"off"` / `"danger-full-access"`) — empty array signals "verbatim spawn"
 *  to {@link linuxOsSandbox} so the result still surfaces with `sandboxApplied:
 *  false` and an OMITTED `degradeReason`. */
export const compileLinuxSandboxArgv = (
  policy: SandboxPolicy,
  workspace: string,
  backend: LinuxSandboxBackend,
): string[] => {
  if (policy.profile === "off" || policy.profile === "danger-full-access") return []
  if (backend === "bubblewrap") return compileBubblewrapArgs(policy, workspace) ?? []
  return compileLandlockCliArgs(policy, workspace) ?? []
}

const defaultWhich = async (binary: string): Promise<string | null> => {
  try {
    const proc = Bun.spawn(["which", binary], { stdout: "pipe", stderr: "pipe" })
    const exit = await proc.exited
    if (exit !== 0) return null
    const out = await new Response(proc.stdout).text()
    const path = out.trim()
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

/** Detect the available Linux sandbox backend. Bubblewrap wins over
 *  landlock-cli when both present (stronger fence). Returns `null` when
 *  neither is on `PATH`. */
export const detectLinuxSandboxBackend = async (
  cfg?: OsSandboxConfig,
): Promise<LinuxSandboxBackend | null> => {
  const which = cfg?.which ?? defaultWhich
  if ((await which("bwrap")) !== null) return "bubblewrap"
  if ((await which("landlock-cli")) !== null) return "landlock-cli"
  return null
}

const defaultSpawner: Spawner = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
}

const passthrough = async (
  spec: SandboxedSpawnSpec,
  spawner: Spawner,
  meta: { sandboxApplied: boolean; degradeReason?: string },
): Promise<SandboxedSpawnResult> => {
  const opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal } = {
    cwd: spec.cwd,
    ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
    ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
  }
  try {
    const r = await spawner([...spec.command], opts)
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      sandboxApplied: meta.sandboxApplied,
      ...(meta.degradeReason !== undefined ? { degradeReason: meta.degradeReason } : {}),
    }
  } catch (e) {
    const msg = errMessage(e)
    return {
      exitCode: 127,
      stdout: "",
      stderr: `spawn-failed: ${msg}`,
      sandboxApplied: false,
      degradeReason: meta.degradeReason ?? "spawn-failed",
    }
  }
}

/** Linux OsSandbox impl. Picks bubblewrap → landlock-cli → passthrough at
 *  spawn-time; profile="off"/"danger-full-access" always passes through. */
export const linuxOsSandbox = (cfg?: OsSandboxConfig): OsSandbox => {
  const spawner = cfg?.spawner ?? defaultSpawner

  return {
    async spawn(spec, policy) {
      if (policy.profile === "off") {
        return passthrough(spec, spawner, { sandboxApplied: false })
      }
      if (policy.profile === "danger-full-access") {
        return passthrough(spec, spawner, { sandboxApplied: false })
      }
      const backend = await detectLinuxSandboxBackend(cfg)
      if (backend === null) {
        return passthrough(spec, spawner, {
          sandboxApplied: false,
          degradeReason: "linux-bwrap-missing",
        })
      }
      if (backend === "bubblewrap") {
        return spawnViaBubblewrap(spec, policy, spawner)
      }
      // landlock-cli backend: compile policy → filter the network-deferred
      // marker (landlock-cli has no network primitive; we record the gap on
      // `degradeReason` so callers see the partial fence honestly).
      const rawArgs = compileLandlockCliArgs(policy, spec.cwd) ?? []
      const filtered = rawArgs.filter((tok) => tok !== LANDLOCK_CLI_NETWORK_DEFERRED_MARKER)
      const networkDeferred = rawArgs.length !== filtered.length
      const argv = ["landlock-cli", ...filtered, "--", ...spec.command]
      const opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal } = {
        cwd: spec.cwd,
        ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
        ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
      }
      try {
        const r = await spawner(argv, opts)
        return {
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          sandboxApplied: true,
          ...(networkDeferred ? { degradeReason: "landlock-network-policy-not-enforced" } : {}),
        }
      } catch (e) {
        const msg = errMessage(e)
        return {
          exitCode: 127,
          stdout: "",
          stderr: `spawn-failed: ${msg}`,
          sandboxApplied: false,
          degradeReason: "spawn-failed",
        }
      }
    },

    async availability(): Promise<SandboxAvailability> {
      const backend = await detectLinuxSandboxBackend(cfg)
      if (backend === null) {
        return {
          backend: "passthrough",
          warnings: ["linux-bwrap-missing", "linux-landlock-cli-missing"],
        }
      }
      return { backend: "landlock+seccomp", warnings: [] }
    },
  }
}
