/**
 * MCP Skybridge — typed sandbox port + policy.
 *
 * Phase 1 (this file): structural shape ONLY. The actual microVM / container
 * adapters land in Phase 2 (ADR-0150 Lima/Apple-Virtualization). The point of
 * Phase 1 is to seal the policy + port surface so the Phase 2 adapter swap is
 * byte-identical at every call site.
 *
 * SOTA reference: Claude Desktop 1.7196.3 "Skybridge" — yukonSilver microVM +
 * Cowork containers + vsock + MITM proxy. Quanta absorbs the STRUCTURAL
 * pattern (typed profile → backend → ipcChannel + sandboxApplied honesty),
 * not the native binding work (deferred to Phase 2 ADR).
 *
 * Plane-clean: this slice imports only standard Node types. No `@/agent`,
 * `@/permission`, `@/tool`, `@/llm`.
 */

/**
 * Closed enum of MCP server isolation profiles. Each profile compiles to a
 * backend-specific config at apply-time. Adding a new arm is a typed change —
 * the registry + every adapter must update with it.
 *
 *  - `off`              : passthrough (default — byte-identical with today).
 *                         Caller explicitly opted out of any isolation.
 *  - `process-isolated` : OS-process boundary only. Formalizes the existing
 *                         posture: no extra enforcement layer, but each MCP
 *                         server is a separate process from the host. Marked
 *                         `sandboxApplied: true` because the OS process boundary
 *                         IS a real (if minimal) isolation.
 *  - `container`        : microVM-Lite — container or chroot-style isolation
 *                         (Phase 2 adapter wiring). Phase 1 stub returns
 *                         "backend-unavailable".
 *  - `microvm`          : full microVM (Phase 2 — Lima / Apple Virtualization /
 *                         firecracker). Phase 1 stub returns "backend-unavailable".
 */
export type SkybridgeProfile = "off" | "process-isolated" | "container" | "microvm"

/**
 * Declarative MCP sandbox policy. The backend (passthrough / container /
 * microvm) interprets these allowlists; Phase 1 passthrough does NOT enforce
 * them — fields are carried for Phase 2 wiring without surface change.
 *
 * exactOptionalPropertyTypes: omitted fields must be absent — never
 * `undefined`-set. Compose with conditional spreads:
 *   const p: McpSandboxPolicy = {
 *     profile,
 *     ...(net ? { networkAllowlist: net } : {}),
 *   }
 */
export interface McpSandboxPolicy {
  readonly profile: SkybridgeProfile
  /** Allowlist of outbound network destinations (`host:port`). Empty = deny-all.
   *  NOT enforced by passthrough adapter — Phase 2 backends only. */
  readonly networkAllowlist?: ReadonlyArray<string>
  /** Allowlist of host filesystem paths the MCP server may read.
   *  NOT enforced by passthrough adapter — Phase 2 backends only. */
  readonly hostReadAllowlist?: ReadonlyArray<string>
  /** Allowlist of host filesystem paths the MCP server may write.
   *  NOT enforced by passthrough adapter — Phase 2 backends only. */
  readonly hostWriteAllowlist?: ReadonlyArray<string>
  /** Wall-clock cap (ms) for the entire MCP server lifetime. */
  readonly maxRuntimeMs?: number
  /** Memory cap (MB). Phase 2 backends only. */
  readonly memoryMb?: number
}

/**
 * What to launch. Mirrors the existing stdio-MCP shape — `command` is argv,
 * `env` is the merged environment (caller decides PATH/secret policy), `cwd`
 * is the working directory.
 */
export interface McpServerSpec {
  /** Stable id within ONE quanta session (e.g. "github-mcp"). */
  readonly id: string
  /** argv of the MCP server. */
  readonly command: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
}

/**
 * IPC endpoint a caller uses to talk to the sandboxed MCP server. Backend-
 * issued: stdio fd for process/passthrough, vsock port for microvm, named
 * pipe for Windows-host container. The caller layers MCP JSON-RPC on top.
 */
export interface McpSandboxIpcChannel {
  readonly kind: "stdio" | "vsock" | "named-pipe"
  /** Backend-resolved reference: PID for stdio, vsock port string for vsock,
   *  pipe name for named-pipe. Opaque to the caller. */
  readonly ref: string
}

/**
 * Handle to a spawned MCP server under a sandbox policy.
 *
 * Honesty contract:
 *   `sandboxApplied: true`  ⇒ an actual isolation layer is in effect
 *   `sandboxApplied: false` ⇒ degraded passthrough; `degradeReason` MUST be
 *                              present unless `profile === "off"` (explicit
 *                              opt-out by the caller).
 *
 * exactOptional: when `sandboxApplied: true`, `degradeReason` MUST be omitted
 * (not `undefined`-set). Compose with conditional spreads.
 */
export interface McpSandboxHandle {
  readonly serverId: string
  readonly profile: SkybridgeProfile
  /** Backend-resolved identifier: PID for process, VM uuid for microvm. */
  readonly backendId: string
  readonly sandboxApplied: boolean
  /** Reason for degradation when sandboxApplied=false but profile !== "off".
   *  OMITTED when sandboxApplied=true; OMITTED when profile==="off" (explicit
   *  opt-out, not a degradation). */
  readonly degradeReason?: string
  readonly ipcChannel: McpSandboxIpcChannel
  /** Stop the sandboxed server. Idempotent (second call is a no-op). */
  stop(): Promise<void>
}

/**
 * Backend identifier reported by `availability()`. Closed union.
 *
 *  - `"passthrough"` : no isolation; legacy or degraded
 *  - `"process"`     : OS process boundary only (no extra enforcement layer)
 *  - `"container"`   : container / chroot-style microVM-Lite
 *  - `"microvm"`     : full microVM (Lima / AV / firecracker)
 */
export type McpSandboxBackend = "passthrough" | "process" | "container" | "microvm"

export interface McpSandboxAvailability {
  readonly backend: McpSandboxBackend
  readonly warnings: ReadonlyArray<string>
}

/**
 * The MCP sandbox port. No-throw on `spawn` — backend failure collapses to a
 * `McpSandboxError` returned via rejection (typed code arm), NEVER an
 * untyped throw. The caller branches on `code` without string matching.
 */
export interface McpSandbox {
  spawn(spec: McpServerSpec, policy: McpSandboxPolicy): Promise<McpSandboxHandle>
  availability(): Promise<McpSandboxAvailability>
}

/**
 * Typed sandbox failure. Stable `code` arm so callers branch without parsing
 * `message`. `cause` carries the original error for diagnostics only.
 */
export class McpSandboxError extends Error {
  readonly code: "backend-unavailable" | "policy-rejected" | "spawn-failed" | "ipc-failed"
  constructor(
    code: "backend-unavailable" | "policy-rejected" | "spawn-failed" | "ipc-failed",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "McpSandboxError"
    this.code = code
  }
}

/**
 * Minimal Spawner contract — what the passthrough adapter needs to launch a
 * subprocess. Caller (test or production wiring) injects this so the slice is
 * free of `node:child_process` / `Bun.spawn` import-time coupling.
 *
 * The returned handle carries an idempotent `stop()` and exposes the stdio
 * channels the caller layers MCP JSON-RPC on top of (mirrors existing
 * `McpClient` usage — stdin write + stdout pump).
 */
export interface SkybridgeSpawnHandle {
  readonly pid: number
  /** Idempotent stop — second call is a no-op. */
  stop(): Promise<void>
}

export type SkybridgeSpawner = (
  argv: ReadonlyArray<string>,
  opts: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
) => Promise<SkybridgeSpawnHandle>

/**
 * Adapter DI config — injection points for the spawner + platform probe +
 * clock. Production wiring uses default arms; tests pass fakes to assert
 * deterministic behavior without touching real subprocesses.
 */
export interface McpSandboxConfig {
  readonly spawner?: SkybridgeSpawner
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
}
