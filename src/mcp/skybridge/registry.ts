/**
 * Skybridge registry — pick the adapter for a policy + platform.
 *
 * Rules (closed; in order):
 *   1. `profile === "off"`               → passthrough (off short-circuits
 *                                          regardless of any wired Phase-2/3
 *                                          adapter — caller explicitly opted
 *                                          out).
 *   2. `profile === "process-isolated"`  → passthrough (the OS process
 *                                          boundary is the layer; nothing to
 *                                          wire on top).
 *   3. `profile === "container"` + `cfg.containerSandbox` wired → use it.
 *   4. `profile === "microvm"` chain (newest-first, then async fallback):
 *      4a. `cfg.nativeAppleVzSandbox`   wired → use it (Phase 3.3+ — ADR-0190)
 *      4b. `cfg.microvmSandbox`          wired → use it (Phase 2 Lima/AppleVZ
 *                                                       external CLI, ADR-0160)
 *   5. Phase-2/3 profile but no matching adapter is wired → passthrough
 *      (degrades; never throws). The passthrough adapter will surface the
 *      degradation honestly via `sandboxApplied=false` +
 *      `degradeReason="phase2-not-implemented"`.
 *
 * The registry NEVER throws — it always returns an `McpSandbox`. The
 * adapter's `spawn` may degrade or reject, but the registry itself is a
 * pure picker.
 *
 * **Phase 3 routing nuance**: the native AVF adapter (`nativeAppleVzSandbox`)
 * is preferred over the external CLI tier when wired, because it produces
 * sub-second boots + native vsock IPC. When `nativeAppleVzSandbox.spawn`
 * rejects with `backend-unavailable` (binding not loaded / AVF probe
 * failed), the CALLER is responsible for retrying with the CLI tier — the
 * registry's synchronous picker does not chain backends (async chaining is
 * the `resolveMcpSandboxAsync` job, deferred to the Lima ADR follow-up).
 */

import { passthroughMcpSandbox } from "./passthrough"
import type { McpSandbox, McpSandboxConfig, McpSandboxPolicy } from "./types"

export interface McpSandboxRegistryConfig extends McpSandboxConfig {
  /** Wired Phase-2 container adapter. Omit to degrade. */
  readonly containerSandbox?: McpSandbox
  /** Wired Phase-2 microvm adapter (Lima / Apple VZ external CLI). Omit to degrade. */
  readonly microvmSandbox?: McpSandbox
  /** Wired Phase-3 native Apple Virtualization adapter (`nativeAppleVzSandbox`).
   *  Higher priority than `microvmSandbox` when both are wired AND policy
   *  profile is `microvm`. Omit on non-darwin hosts. (ADR-0190) */
  readonly nativeAppleVzSandbox?: McpSandbox
}

export const resolveMcpSandbox = (
  policy: McpSandboxPolicy,
  cfg: McpSandboxRegistryConfig = {},
): McpSandbox => {
  // Strip the Phase-2/3-adapter slots before passing to passthrough (its
  // config type doesn't carry them; harmless but cleaner).
  const passthroughCfg: McpSandboxConfig = {
    ...(cfg.spawner !== undefined ? { spawner: cfg.spawner } : {}),
    ...(cfg.platform !== undefined ? { platform: cfg.platform } : {}),
    ...(cfg.now !== undefined ? { now: cfg.now } : {}),
  }

  // Rule 1: off short-circuits before any wired backend is considered.
  if (policy.profile === "off") return passthroughMcpSandbox(passthroughCfg)
  // Rule 2: process-isolated also passes through.
  if (policy.profile === "process-isolated") return passthroughMcpSandbox(passthroughCfg)
  // Rule 3: container + wired
  if (policy.profile === "container" && cfg.containerSandbox !== undefined) {
    return cfg.containerSandbox
  }
  // Rule 4a: microvm + native AVF wired — Phase 3.3+ winner.
  if (policy.profile === "microvm" && cfg.nativeAppleVzSandbox !== undefined) {
    return cfg.nativeAppleVzSandbox
  }
  // Rule 4b: microvm + Phase 2 external CLI wired — Lima / AppleVZ-CLI.
  if (policy.profile === "microvm" && cfg.microvmSandbox !== undefined) {
    return cfg.microvmSandbox
  }
  // Rule 5: Phase-2/3 profile but unwired → degrade to passthrough.
  return passthroughMcpSandbox(passthroughCfg)
}
