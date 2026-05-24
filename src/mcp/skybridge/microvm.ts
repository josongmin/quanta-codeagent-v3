/**
 * MicroVM backend stub — Phase 2 placeholder.
 *
 * Phase 2 will wire a real microVM adapter:
 *   - macOS: Apple Virtualization framework (`Virtualization.framework` via a
 *            helper binary, or Lima).
 *   - Linux: firecracker / cloud-hypervisor / Lima.
 *   - Windows: WSL2 / Hyper-V (deferred — Phase 3).
 *
 * vsock will be the IPC primitive (matches Claude Desktop Skybridge's
 * yukonSilver pattern). Phase 1 ships the file SHAPE so the swap is
 * mechanical: replace the body, no caller change.
 *
 * Contract: `spawn` rejects with `McpSandboxError("backend-unavailable", …)`.
 * `availability` reports `backend: "microvm"` + a wired-but-not-implemented
 * warning. As with the container stub, this does NOT internally degrade to
 * passthrough — that decision is the registry's.
 */

import {
  type McpSandbox,
  type McpSandboxAvailability,
  McpSandboxError,
  type McpSandboxHandle,
  type McpSandboxPolicy,
  type McpServerSpec,
} from "./types"

export const microvmMcpSandbox = (): McpSandbox => ({
  async spawn(_spec: McpServerSpec, _policy: McpSandboxPolicy): Promise<McpSandboxHandle> {
    throw new McpSandboxError("backend-unavailable", "Phase 2 — microvm backend not implemented")
  },
  async availability(): Promise<McpSandboxAvailability> {
    return {
      backend: "microvm",
      warnings: ["Phase 2 — microvm backend not implemented"],
    }
  },
})
