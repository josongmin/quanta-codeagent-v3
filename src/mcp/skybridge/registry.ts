/**
 * Skybridge registry — pick the adapter for a policy + platform.
 *
 * Rules (closed; in order):
 *   1. `profile === "off"`               → passthrough (off short-circuits
 *                                          regardless of any wired Phase-2
 *                                          adapter — caller explicitly opted
 *                                          out).
 *   2. `profile === "process-isolated"`  → passthrough (the OS process
 *                                          boundary is the layer; nothing to
 *                                          wire on top).
 *   3. `profile === "container"` + `cfg.containerSandbox` wired → use it.
 *   4. `profile === "microvm"`   + `cfg.microvmSandbox`  wired → use it.
 *   5. Phase-2 profile but the matching adapter is NOT wired → passthrough
 *      (degrades; never throws). The passthrough adapter will surface the
 *      degradation honestly via `sandboxApplied=false` +
 *      `degradeReason="phase2-not-implemented"`.
 *
 * The registry NEVER throws — it always returns an `McpSandbox`. The
 * adapter's `spawn` may degrade, but the registry itself is a pure picker.
 */

import { passthroughMcpSandbox } from "./passthrough"
import type { McpSandbox, McpSandboxConfig, McpSandboxPolicy } from "./types"

export interface McpSandboxRegistryConfig extends McpSandboxConfig {
  /** Wired Phase-2 container adapter. Omit to degrade. */
  readonly containerSandbox?: McpSandbox
  /** Wired Phase-2 microvm adapter. Omit to degrade. */
  readonly microvmSandbox?: McpSandbox
}

export const resolveMcpSandbox = (
  policy: McpSandboxPolicy,
  cfg: McpSandboxRegistryConfig = {},
): McpSandbox => {
  // Strip the Phase-2-adapter slots before passing to passthrough (its config
  // type doesn't carry them; harmless but cleaner).
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
  // Rule 4: microvm + wired
  if (policy.profile === "microvm" && cfg.microvmSandbox !== undefined) {
    return cfg.microvmSandbox
  }
  // Rule 5: Phase-2 profile but unwired → degrade to passthrough.
  return passthroughMcpSandbox(passthroughCfg)
}
