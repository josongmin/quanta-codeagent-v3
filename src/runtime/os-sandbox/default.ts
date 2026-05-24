import { spawn as nodeSpawn } from "node:child_process"
import { isBubblewrapAvailable, spawnViaBubblewrap } from "./landlock"
import {
  detectNativeLandlock,
  type NativeLandlockConfig,
  nativeLandlockOsSandbox,
} from "./landlock-native"
import { compileSeatbeltProfile } from "./seatbelt"
import type {
  OsSandbox,
  OsSandboxConfig,
  SandboxAvailability,
  SandboxedSpawnResult,
  SandboxedSpawnSpec,
  SandboxPolicy,
  Spawner,
} from "./types"

/**
 * Default {@link OsSandbox} implementation. Closed-port DI: pass `cfg.spawner`
 * to inject a fake in tests; production wires the real Bun-spawn-compatible
 * default below.
 */
export const defaultOsSandbox = (cfg: NativeLandlockConfig = {}): OsSandbox => {
  const platform: NodeJS.Platform = cfg.platform ?? process.platform
  const spawner: Spawner = cfg.spawner ?? defaultSpawner
  const which = cfg.which ?? defaultWhich

  return {
    async spawn(spec, policy) {
      return spawnImpl({ spec, policy, platform, spawner, which, nativeCfg: cfg })
    },
    async availability() {
      return availabilityImpl({ platform, which, nativeCfg: cfg })
    },
  }
}

/* ------------------------------------------------------------------ */
/*  spawn                                                             */
/* ------------------------------------------------------------------ */

const spawnImpl = async (args: {
  spec: SandboxedSpawnSpec
  policy: SandboxPolicy
  platform: NodeJS.Platform
  spawner: Spawner
  which: (b: string) => Promise<string | null>
  nativeCfg: NativeLandlockConfig
}): Promise<SandboxedSpawnResult> => {
  const { spec, policy, platform, spawner, which, nativeCfg } = args

  // off / danger-full-access: pass-through verbatim. sandboxApplied=false,
  // NO degradeReason (because the caller explicitly asked for no sandbox).
  if (policy.profile === "off" || policy.profile === "danger-full-access") {
    return passthrough(spec, spawner, { sandboxApplied: false })
  }

  // macOS: try Seatbelt.
  if (platform === "darwin") {
    const sandboxExec = await which("sandbox-exec")
    if (sandboxExec === null) {
      return passthrough(spec, spawner, {
        sandboxApplied: false,
        degradeReason: "sandbox-exec-missing",
      })
    }
    const profile = compileSeatbeltProfile(policy, spec.cwd)
    if (profile === null) {
      // Shouldn't happen given the off/danger short-circuit above, but the
      // null branch is part of the typed contract — degrade honestly.
      return passthrough(spec, spawner, {
        sandboxApplied: false,
        degradeReason: "profile-uncompilable",
      })
    }
    return runSeatbelt({ sandboxExec, profile, spec, spawner })
  }

  // Linux fallback chain (ADR-0175 — Phase 3 native landlock on top of
  // Phase 2 bwrap fallback):
  //   1. nativeLandlockOsSandbox — when @quanta/linux-sandbox-native is
  //      loaded AND the kernel supports Landlock (probe via
  //      detectNativeLandlock).
  //   2. spawnViaBubblewrap (ADR-0150) — when `bwrap` is on PATH.
  //   3. degraded passthrough with an actionable install hint.
  //
  // The native probe is a no-op when the package isn't installed (returns
  // null synchronously after a typed JSON parse), so non-Linux hosts and
  // Linux hosts without the optional dep both flow through to the Phase 2
  // path without any spurious throws.
  if (platform === "linux") {
    const native = await detectNativeLandlock(nativeCfg)
    if (native !== null) {
      return nativeLandlockOsSandbox(nativeCfg).spawn(spec, policy)
    }
    if (await isBubblewrapAvailable(which)) {
      return spawnViaBubblewrap(spec, policy, spawner)
    }
    return passthrough(spec, spawner, {
      sandboxApplied: false,
      degradeReason: "linux-bwrap-missing — install bubblewrap (apt/dnf/pacman)",
    })
  }

  // Other platforms (win32, etc.): passthrough + reason.
  return passthrough(spec, spawner, {
    sandboxApplied: false,
    degradeReason: `unsupported-platform:${platform}`,
  })
}

const runSeatbelt = async (args: {
  sandboxExec: string
  profile: string
  spec: SandboxedSpawnSpec
  spawner: Spawner
}): Promise<SandboxedSpawnResult> => {
  const { sandboxExec, profile, spec, spawner } = args
  const argv = [sandboxExec, "-p", profile, ...spec.command]
  const opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal } = {
    cwd: spec.cwd,
    ...(spec.env ? { env: { ...spec.env } } : {}),
    ...(spec.signal ? { signal: spec.signal } : {}),
  }
  try {
    const r = await spawner(argv, opts)
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      sandboxApplied: true,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      exitCode: 127,
      stdout: "",
      stderr: `spawn-failed: ${msg}`,
      sandboxApplied: false,
      degradeReason: "spawn-failed",
    }
  }
}

const passthrough = async (
  spec: SandboxedSpawnSpec,
  spawner: Spawner,
  meta: { sandboxApplied: boolean; degradeReason?: string },
): Promise<SandboxedSpawnResult> => {
  const argv: string[] = [...spec.command]
  const opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal } = {
    cwd: spec.cwd,
    ...(spec.env ? { env: { ...spec.env } } : {}),
    ...(spec.signal ? { signal: spec.signal } : {}),
  }
  try {
    const r = await spawner(argv, opts)
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      sandboxApplied: meta.sandboxApplied,
      ...(meta.degradeReason !== undefined ? { degradeReason: meta.degradeReason } : {}),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      exitCode: 127,
      stdout: "",
      stderr: `spawn-failed: ${msg}`,
      sandboxApplied: false,
      degradeReason: meta.degradeReason ?? "spawn-failed",
    }
  }
}

/* ------------------------------------------------------------------ */
/*  availability                                                      */
/* ------------------------------------------------------------------ */

const availabilityImpl = async (args: {
  platform: NodeJS.Platform
  which: (b: string) => Promise<string | null>
  nativeCfg: NativeLandlockConfig
}): Promise<SandboxAvailability> => {
  const { platform, which, nativeCfg } = args
  if (platform === "darwin") {
    const sb = await which("sandbox-exec")
    if (sb !== null) return { backend: "seatbelt", warnings: [] }
    return {
      backend: "passthrough",
      warnings: ["darwin: sandbox-exec not found on PATH — degraded to passthrough"],
    }
  }
  if (platform === "linux") {
    // Tier 1: native landlock (ADR-0175). When the napi binding loads + the
    // kernel reports a usable Landlock ABI, this wins over bubblewrap.
    const native = await detectNativeLandlock(nativeCfg)
    if (native !== null) {
      return { backend: "landlock+seccomp", warnings: [] }
    }
    // Tier 2: bubblewrap (ADR-0150).
    const bw = await which("bwrap")
    if (bw !== null) {
      return { backend: "bubblewrap", warnings: [] }
    }
    return {
      backend: "passthrough",
      warnings: [
        "linux: install bubblewrap for sandbox (apt/dnf/pacman) — degraded to passthrough",
      ],
    }
  }
  return {
    backend: "passthrough",
    warnings: [`unsupported platform: ${platform} — degraded to passthrough`],
  }
}

/* ------------------------------------------------------------------ */
/*  default spawner + which                                           */
/* ------------------------------------------------------------------ */

/**
 * Default spawner over node:child_process. Bun.spawn-compatible buffered
 * shape (stdout/stderr captured as utf8 strings). Production callers in
 * other slices may inject a Bun-native spawner instead; the shape is
 * intentionally minimal.
 */
const defaultSpawner: Spawner = (argv, opts) =>
  new Promise((resolve, reject) => {
    if (argv.length === 0) {
      reject(new Error("argv empty"))
      return
    }
    const [cmd, ...rest] = argv
    if (cmd === undefined) {
      reject(new Error("argv[0] undefined"))
      return
    }
    const child = nodeSpawn(cmd, rest, {
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c))
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c))

    let aborted = false
    const onAbort = () => {
      aborted = true
      try {
        child.kill("SIGTERM")
      } catch {
        // already exited
      }
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort()
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    child.on("error", (err) => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
      reject(err)
    })
    child.on("close", (code) => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
      resolve({
        exitCode: aborted ? 130 : (code ?? 0),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      })
    })
  })

/** Default `which` via `command -v` subprocess. Returns the absolute path or
 *  null. Plane-clean: uses only node:child_process. */
const defaultWhich = (binary: string): Promise<string | null> =>
  new Promise((resolve) => {
    const child = nodeSpawn("/bin/sh", ["-c", `command -v ${shellEscape(binary)}`], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    const chunks: Buffer[] = []
    child.stdout?.on("data", (c: Buffer) => chunks.push(c))
    child.on("error", () => resolve(null))
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const out = Buffer.concat(chunks).toString("utf8").trim()
      resolve(out.length > 0 ? out : null)
    })
  })

/** Escape a binary name for safe inclusion in a `sh -c` argv (defense-in-depth;
 *  the caller is internal but the value flows from `cfg.which` callers). */
const shellEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
