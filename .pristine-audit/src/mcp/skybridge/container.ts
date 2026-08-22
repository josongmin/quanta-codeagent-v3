/**
 * Container backend stub — Phase 2 placeholder.
 *
 * Phase 2 will implement microVM-Lite isolation via container or chroot-style
 * mechanisms (e.g. Docker, podman, systemd-nspawn, or a chroot+namespace
 * wrapper). Phase 1 ships the file SHAPE so the swap is mechanical: replace
 * the body, no caller change.
 *
 * Contract: `spawn` rejects with `McpSandboxError("backend-unavailable", …)`.
 * `availability` reports `backend: "container"` + a wired-but-not-implemented
 * warning so the operator sees the gap without a silent fallthrough.
 *
 * NOTE — by design, this stub does NOT degrade to passthrough internally.
 * Degradation is the `registry`'s decision: when the caller wires only a
 * passthrough adapter, the registry can choose to degrade. If the caller
 * explicitly wires this stub, the rejection is intentional — they asked for
 * container isolation, and they need to know we can't yet deliver.
 */

import {
  type McpSandbox,
  type McpSandboxAvailability,
  McpSandboxError,
  type McpSandboxHandle,
  type McpSandboxPolicy,
  type McpServerSpec,
} from "./types"

export const containerMcpSandbox = (): McpSandbox => ({
  async spawn(_spec: McpServerSpec, _policy: McpSandboxPolicy): Promise<McpSandboxHandle> {
    throw new McpSandboxError("backend-unavailable", "Phase 2 — container backend not implemented")
  },
  async availability(): Promise<McpSandboxAvailability> {
    return {
      backend: "container",
      warnings: ["Phase 2 — container backend not implemented"],
    }
  },
})
