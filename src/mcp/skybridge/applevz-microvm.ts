/**
 * Apple Virtualization (vz) microVM backend — macOS-only Phase 2 adapter
 * (ADR-0160).
 *
 * Wraps a community `vz` CLI (e.g. `cirruslabs/vz`, `evansm7/vftool`,
 * `Veertu/anka` — any external binary exposing a "shell into a VM"
 * subcommand). Structurally identical to the Lima adapter:
 *   probe → vm-name from spec.id → spawn via `vz shell <vm> -- <argv>`.
 *
 * Differences vs Lima:
 *   - macOS-only (Apple Virtualization framework is darwin-exclusive).
 *   - Smaller footprint than Lima (no qemu, native hypervisor calls).
 *   - Fewer guest image options (Linux-only, no Windows guest support).
 *
 * Phase 3 will replace this CLI-wrapper with a direct Virtualization.framework
 * FFI (Swift binding via Bun FFI or napi-rs); the port surface is identical
 * so the swap is local to this file.
 */

import {
  type McpSandbox,
  type McpSandboxAvailability,
  type McpSandboxConfig,
  McpSandboxError,
  type McpSandboxHandle,
  type McpSandboxPolicy,
  type McpServerSpec,
  type SkybridgeSpawner,
} from "./types"

/**
 * Detect `vz` CLI availability. Returns binary path OR `null`.
 *
 * Platform-gated: returns `null` on non-darwin hosts (Apple Virtualization
 * is darwin-exclusive). The platform probe uses `cfg.platform` (caller-
 * injected for cross-host testing) and falls back to `process.platform`
 * which is the Node-standard global.
 */
export const detectAppleVz = async (cfg: McpSandboxConfig = {}): Promise<string | null> => {
  const platform = cfg.platform ?? process.platform
  if (platform !== "darwin") return null
  const which = cfg.which
  if (which === undefined) return null
  return which("vz")
}

/** Deterministic VM name from a spec id. Mirrors {@link lima-microvm.limaVmName}. */
export const appleVzVmName = (specId: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < specId.length; i++) {
    h ^= specId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `quanta-vz-${h.toString(16).padStart(8, "0")}`
}

/**
 * Apple VZ-backed McpSandbox. Mirror of {@link limaMicroVmSandbox} with
 * `vz` command shapes instead of `lima` ones.
 */
const requireAppleVzWired = async (cfg: McpSandboxConfig): Promise<SkybridgeSpawner> => {
  const vzPath = await detectAppleVz(cfg)
  if (vzPath === null) {
    const platform = cfg.platform ?? process.platform
    if (platform !== "darwin") {
      throw new McpSandboxError(
        "backend-unavailable",
        `Apple Virtualization backend is darwin-only (platform=${platform})`,
      )
    }
    throw new McpSandboxError(
      "backend-unavailable",
      "vz binary not found on PATH (community Apple Virtualization CLI — see ADR-0160 Follow-up)",
    )
  }
  if (cfg.spawner === undefined) {
    throw new McpSandboxError(
      "backend-unavailable",
      "Apple-VZ backend requires a SkybridgeSpawner — none wired in McpSandboxConfig",
    )
  }
  return cfg.spawner
}

const buildAppleVzRunArgs = (
  policy: McpSandboxPolicy,
  spec: McpServerSpec,
  vmName: string,
): string[] => {
  const baseRun: string[] = ["vz", "shell", vmName, "--", ...spec.command]
  return policy.maxRuntimeMs !== undefined
    ? ["timeout", `${Math.max(1, Math.floor(policy.maxRuntimeMs / 1000))}s`, ...baseRun]
    : baseRun
}

const buildAppleVzOpts = (
  spec: McpServerSpec,
): { cwd?: string; env?: Readonly<Record<string, string>> } => ({
  ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
  ...(spec.env !== undefined ? { env: spec.env } : {}),
})

const appleVzIdempotentStop = (inner: { stop: () => Promise<void> }): (() => Promise<void>) => {
  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    await inner.stop()
  }
}

export const appleVzMicroVmSandbox = (cfg: McpSandboxConfig = {}): McpSandbox => {
  return {
    async spawn(spec: McpServerSpec, policy: McpSandboxPolicy): Promise<McpSandboxHandle> {
      const spawner = await requireAppleVzWired(cfg)
      const vmName = appleVzVmName(spec.id)
      const runArgs = buildAppleVzRunArgs(policy, spec, vmName)

      let raw: { pid: number; stop: () => Promise<void> }
      try {
        raw = await spawner(runArgs, buildAppleVzOpts(spec))
      } catch (e) {
        throw new McpSandboxError(
          "spawn-failed",
          `vz shell spawn failed: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        )
      }

      return {
        serverId: spec.id,
        profile: policy.profile,
        backendId: vmName,
        sandboxApplied: true,
        ipcChannel: { kind: "named-pipe", ref: `vz-socket:${vmName}` },
        stop: appleVzIdempotentStop(raw),
      }
    },

    async availability(): Promise<McpSandboxAvailability> {
      const vzPath = await detectAppleVz(cfg)
      if (vzPath !== null) {
        return {
          backend: "microvm",
          warnings: ["Apple-VZ CLI wrapper; direct Virtualization.framework FFI is Phase 3"],
        }
      }
      const platform = cfg.platform ?? process.platform
      if (platform !== "darwin") {
        return {
          backend: "passthrough",
          warnings: [`Apple-VZ backend is darwin-only (platform=${platform})`],
        }
      }
      return {
        backend: "passthrough",
        warnings: ["vz CLI not installed; this backend is optional alongside Lima"],
      }
    },
  }
}
