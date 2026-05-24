/**
 * Passthrough MCP sandbox — Phase 1 default adapter.
 *
 * Wraps a `SkybridgeSpawner` and reports honestly:
 *   profile="off"               → spawn; sandboxApplied=false; NO degradeReason
 *                                 (explicit opt-out, not a degradation).
 *   profile="process-isolated"  → spawn; sandboxApplied=TRUE (the OS process
 *                                 boundary IS a real, if minimal, layer of
 *                                 isolation — host can't read the MCP server's
 *                                 address space, MCP server has its own fd
 *                                 table, etc.); NO degradeReason.
 *   profile="container"         → spawn; sandboxApplied=false;
 *                                 degradeReason="phase2-not-implemented".
 *   profile="microvm"           → same as container (Phase 2 deferred).
 *
 * Critical: container/microvm STILL spawn the MCP server — we don't break the
 * MCP connection just because the requested isolation layer isn't wired. The
 * caller gets a working IPC channel + an honest `sandboxApplied=false` so the
 * UI / metrics / policy layer can warn the operator.
 *
 * If `cfg.spawner` is omitted, `spawn()` resolves to a degraded handle with
 * `degradeReason="spawn-failed: no spawner wired"` rather than throwing —
 * Phase 1 doesn't import `node:child_process` / `Bun.spawn` directly to
 * preserve plane-cleanliness; production wiring at the @/agent assembly point
 * injects the real spawner.
 */

import type {
  McpSandbox,
  McpSandboxAvailability,
  McpSandboxConfig,
  McpSandboxHandle,
  McpSandboxPolicy,
  McpServerSpec,
  SkybridgeProfile,
  SkybridgeSpawner,
  SkybridgeSpawnHandle,
} from "./types"

/** Backends not wired in Phase 1 — passthrough still spawns, marks degraded. */
const PHASE_2_PROFILES: ReadonlySet<SkybridgeProfile> = new Set(["container", "microvm"])

/** Synthetic stop handle for the no-spawner-wired degraded path. Idempotent. */
const noopHandle = (): SkybridgeSpawnHandle => ({
  pid: -1,
  stop: async () => undefined,
})

/**
 * Wrap a `SkybridgeSpawnHandle.stop` to guarantee idempotency at the adapter
 * boundary. Even if the underlying spawner's stop is already idempotent, this
 * ensures the McpSandbox contract is met regardless of spawner implementation.
 */
const idempotentStop = (inner: SkybridgeSpawnHandle): (() => Promise<void>) => {
  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    await inner.stop()
  }
}

/**
 * Build an `McpSandboxHandle` from the raw spawn handle + profile decision.
 * Uses exactOptional conditional-spread for `degradeReason` so the field is
 * OMITTED (not `undefined`-set) when sandbox is applied or profile is "off".
 */
const buildHandle = (args: {
  readonly serverId: string
  readonly profile: SkybridgeProfile
  readonly raw: SkybridgeSpawnHandle
  readonly sandboxApplied: boolean
  readonly degradeReason: string | null
}): McpSandboxHandle => {
  const { serverId, profile, raw, sandboxApplied, degradeReason } = args
  return {
    serverId,
    profile,
    backendId: String(raw.pid),
    sandboxApplied,
    ...(degradeReason !== null ? { degradeReason } : {}),
    ipcChannel: { kind: "stdio", ref: String(raw.pid) },
    stop: idempotentStop(raw),
  }
}

/**
 * Decide the (sandboxApplied, degradeReason) pair for a profile under
 * passthrough semantics. Pure — no side effects.
 *
 * NOTE — process-isolated is `sandboxApplied: true`:
 *   The OS process boundary is itself a real (though minimal) isolation
 *   layer. We don't add anything beyond what `spawn` already gives, but
 *   neither is that NOTHING — the MCP server runs in a separate address
 *   space, with its own fd table, signal disposition, and (modulo
 *   sharedmem) memory protection. Marking process-isolated as
 *   `sandboxApplied: true` reflects the honest minimum.
 *
 *   The richer profiles (container / microvm) are reserved for layers that
 *   add MORE than the OS process boundary: FS namespace, network namespace,
 *   syscall filter, memory cap. Those are Phase 2.
 */
const decideApplied = (profile: SkybridgeProfile): { applied: boolean; reason: string | null } => {
  if (profile === "off") return { applied: false, reason: null }
  if (profile === "process-isolated") return { applied: true, reason: null }
  if (PHASE_2_PROFILES.has(profile)) {
    return { applied: false, reason: "phase2-not-implemented" }
  }
  // Unreachable under the closed union, but no fall-through.
  return { applied: false, reason: "unknown-profile" }
}

const PASSTHROUGH_WARNING =
  "Phase 2 backends (container, microvm) not implemented — requests for those profiles will spawn but report sandboxApplied=false"

/**
 * Build the passthrough adapter. `cfg.spawner` is optional: production wiring
 * injects a real Bun.spawn / node:child_process spawner from the @/agent
 * assembly layer; tests inject fakes.
 */
export const passthroughMcpSandbox = (cfg: McpSandboxConfig = {}): McpSandbox => {
  const spawner: SkybridgeSpawner | undefined = cfg.spawner

  return {
    async spawn(spec: McpServerSpec, policy: McpSandboxPolicy): Promise<McpSandboxHandle> {
      const { applied, reason } = decideApplied(policy.profile)

      // No spawner wired: return a degraded handle (no-throw). The
      // production assembly point is responsible for injecting one; this
      // arm exists for unit tests + Phase-1 staging.
      if (spawner === undefined) {
        return buildHandle({
          serverId: spec.id,
          profile: policy.profile,
          raw: noopHandle(),
          sandboxApplied: false,
          degradeReason: reason ?? "spawn-failed: no spawner wired",
        })
      }

      // Always attempt to spawn — even for Phase-2 profiles. The MCP
      // connection MUST work; only the isolation honesty bit differs.
      const argv = spec.command
      const opts: { cwd?: string; env?: Readonly<Record<string, string>> } = {
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
      }

      let raw: SkybridgeSpawnHandle
      try {
        raw = await spawner(argv, opts)
      } catch (err) {
        // Spawner failure: degraded handle with backendId="error". No throw —
        // the no-throw contract collapses backend failure to a typed-shape
        // return. Caller branches on sandboxApplied=false + degradeReason.
        const msg = err instanceof Error ? err.message : String(err)
        return {
          serverId: spec.id,
          profile: policy.profile,
          backendId: "error",
          sandboxApplied: false,
          degradeReason: `spawn-failed: ${msg}`,
          ipcChannel: { kind: "stdio", ref: "error" },
          stop: async () => undefined,
        }
      }

      return buildHandle({
        serverId: spec.id,
        profile: policy.profile,
        raw,
        sandboxApplied: applied,
        degradeReason: reason,
      })
    },

    async availability(): Promise<McpSandboxAvailability> {
      return {
        backend: "passthrough",
        warnings: [PASSTHROUGH_WARNING],
      }
    },
  }
}
