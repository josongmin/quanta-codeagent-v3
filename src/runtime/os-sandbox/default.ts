import { spawn as nodeSpawn } from "node:child_process"
import { errMessage } from "@/shared"
import { isBubblewrapAvailable, spawnViaBubblewrap } from "./landlock"
import {
  detectNativeLandlock,
  type NativeLandlockConfig,
  nativeLandlockOsSandbox,
} from "./landlock-native"
import { sandboxUnavailableRefusal } from "./refusal"
import { compileSeatbeltProfile } from "./seatbelt"
import type {
  OsSandbox,
  SandboxAvailability,
  SandboxedSpawnResult,
  SandboxedSpawnSpec,
  SandboxPolicy,
  Spawner,
} from "./types"
import {
  detectNativeWindows,
  type NativeWindowsConfig,
  nativeWindowsOsSandbox,
} from "./windows-native"

/**
 * Combined closed-port DI config for {@link defaultOsSandbox}.
 *
 * The Linux native binding lives at the top level (`binding` /
 * `bindingLoader`) — backward-compatible with every existing caller. The
 * Windows native binding (ADR-0441) is NAMESPACED under `windows.*` because
 * its `binding`/`bindingLoader` shapes differ from Landlock's and a flat
 * intersection would be unsatisfiable. Only the branch matching `cfg.platform`
 * reads the platform-relevant fields.
 */
export interface DefaultOsSandboxConfig extends NativeLandlockConfig {
  /** Windows broker-helper DI (ADR-0441). Tests inject a fake binding here;
   *  production leaves it absent and the adapter lazily loads the helper. */
  readonly windows?: Pick<NativeWindowsConfig, "binding" | "bindingLoader" | "failClosedOnNetwork">
}

/** Project the combined config down to a standalone {@link NativeWindowsConfig}
 *  for the win32 branch — carries spawner/platform/which through verbatim and
 *  lifts the namespaced `windows.*` DI fields to the top level the adapter
 *  expects. exactOptional: omit absent fields rather than set `undefined`. */
const toWindowsConfig = (cfg: DefaultOsSandboxConfig): NativeWindowsConfig => ({
  ...(cfg.spawner !== undefined ? { spawner: cfg.spawner } : {}),
  ...(cfg.platform !== undefined ? { platform: cfg.platform } : {}),
  ...(cfg.which !== undefined ? { which: cfg.which } : {}),
  ...(cfg.windows?.binding !== undefined ? { binding: cfg.windows.binding } : {}),
  ...(cfg.windows?.bindingLoader !== undefined ? { bindingLoader: cfg.windows.bindingLoader } : {}),
  ...(cfg.windows?.failClosedOnNetwork !== undefined
    ? { failClosedOnNetwork: cfg.windows.failClosedOnNetwork }
    : {}),
})

/**
 * Default {@link OsSandbox} implementation. Closed-port DI: pass `cfg.spawner`
 * to inject a fake in tests; production wires the real Bun-spawn-compatible
 * default below.
 */
export const defaultOsSandbox = (cfg: DefaultOsSandboxConfig = {}): OsSandbox => {
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
  nativeCfg: DefaultOsSandboxConfig
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
      // FAIL-CLOSED (DOF-40): sandbox requested, sandbox-exec absent ⇒ typed
      // refusal, command NOT run (was fail-open passthrough).
      return sandboxUnavailableRefusal("sandbox-exec-missing")
    }
    const profile = compileSeatbeltProfile(policy, spec.cwd)
    if (profile === null) {
      // Shouldn't happen given the off/danger short-circuit above, but the
      // null branch is part of the typed contract — FAIL-CLOSED refusal, not a
      // silent unsandboxed run.
      return sandboxUnavailableRefusal("profile-uncompilable")
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
    // FAIL-CLOSED (DOF-40): no native landlock, no bwrap ⇒ a REQUESTED sandbox
    // cannot be enforced. Refuse the spawn (typed refusal, command NOT run)
    // instead of the old degraded passthrough that ran the command unsandboxed.
    return sandboxUnavailableRefusal("linux-bwrap-missing")
  }

  // Windows (win32) — ADR-0441 broker-helper backend:
  //   1. nativeWindowsOsSandbox — when the helper exe
  //      (`quanta-win-sandbox.exe`) is present (probe via detectNativeWindows).
  //   2. degraded passthrough with a LOUD, actionable install hint.
  //
  // HONEST: the helper exe is an L3 backlog artifact (not yet built/installed),
  // so today this ALWAYS falls to the passthrough branch. That branch is
  // byte-identical to the legacy behavior (sandboxApplied=false, same
  // exit/out/err) — the ONLY change is the degradeReason string becomes
  // actionable instead of `unsupported-platform:win32`.
  if (platform === "win32") {
    const winCfg = toWindowsConfig(nativeCfg)
    const native = await detectNativeWindows(winCfg)
    if (native !== null) {
      return nativeWindowsOsSandbox(winCfg).spawn(spec, policy)
    }
    // FAIL-CLOSED (DOF-40): sandbox requested, Windows helper absent ⇒ typed
    // refusal, command NOT run (was fail-open degraded passthrough).
    return sandboxUnavailableRefusal("win32-sandbox-helper-missing")
  }

  // Other platforms (sunos, aix, etc.): a requested sandbox cannot be enforced
  // ⇒ FAIL-CLOSED refusal, never a silent unsandboxed run.
  return sandboxUnavailableRefusal(`unsupported-platform:${platform}`)
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
    const msg = errMessage(e)
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

/* ------------------------------------------------------------------ */
/*  availability                                                      */
/* ------------------------------------------------------------------ */

const availabilityImpl = async (args: {
  platform: NodeJS.Platform
  which: (b: string) => Promise<string | null>
  nativeCfg: DefaultOsSandboxConfig
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
  if (platform === "win32") {
    // ADR-0441 — Windows broker helper. Present ⇒ honest
    // `windows-restricted-token` backend; absent ⇒ passthrough with a LOUD
    // warning (the default state today, since the helper exe is L3 backlog).
    const native = await detectNativeWindows(toWindowsConfig(nativeCfg))
    if (native !== null) {
      return { backend: "windows-restricted-token", warnings: [] }
    }
    return {
      backend: "passthrough",
      warnings: [
        "win32: quanta-win-sandbox.exe not found — degraded to passthrough (no OS isolation)",
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
