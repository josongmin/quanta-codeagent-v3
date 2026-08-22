/**
 * MCP Skybridge — **native Apple Virtualization** backend via the napi-rs
 * binding `@quanta/darwin-vz-helper` (ADR-0190 Phase 3.3 scaffold).
 *
 * Sibling adapter to `src/runtime/os-sandbox/landlock-native.ts` — same
 * shape, different framework. Loaded as an OPTIONAL dependency; when the
 * package is not installed (non-darwin host, install opt-out, unsupported
 * arch), this adapter degrades cleanly and `registry.ts` falls through to
 * the Phase 2 external-binary wrappers (Lima / AppleVZ CLI, ADR-0160) and
 * finally to passthrough.
 *
 * Design contract:
 *  - `nativeAppleVzSandbox(cfg)` always returns an `McpSandbox` — never
 *    throws at construction. When the binding can't be loaded, `spawn()`
 *    rejects with `McpSandboxError("backend-unavailable", …)` (caller-
 *    explicit use of THIS backend is degradation; the registry uses
 *    `availability()` cheap probe to route around it).
 *  - `detectNativeAppleVz()` is the cheap probe used by `registry.ts` —
 *    returns `null` whenever the binding is unavailable OR `availability()`
 *    reports unavailable; never throws.
 *  - Closed-port DI: tests inject a fake binding via `cfg.binding` (or
 *    `cfg.bindingLoader`); production wires the real
 *    `@quanta/darwin-vz-helper` lazily.
 *
 * **Phase 3.3 honesty**: the real binding's `availability()` returns
 * `available: false` with reason `"vz-phase3.3-scaffold"` until Phase 3.4
 * fills the VZ bring-up bodies. Tests against the FAKE binding can drive
 * any availability shape — that's the closed-port DI seam.
 */

import { errMessage } from "@/shared"
import {
  type McpSandbox,
  type McpSandboxAvailability,
  type McpSandboxConfig,
  McpSandboxError,
  type McpSandboxHandle,
  type McpSandboxPolicy,
  type McpServerSpec,
} from "./types"
/** napi-rs spawn result shape (camelCase across napi boundary; matches
 *  `crates/darwin-vz-helper/src/lib.rs::NapiVmSpawnResult`). */
export interface NapiVmSpawnResult {
  readonly vmId: string
  readonly ipcKind: string
  readonly ipcRef: string
  readonly sandboxApplied: boolean
  readonly degradeReason?: string
}

/** napi-rs MCP VM policy shape (matches `NapiMcpVmPolicy`). Required
 *  array fields default to `[]` rather than absent — same pattern as
 *  `NapiSandboxPolicy.extra_*_paths` in `linux-sandbox-native` (napi-rs
 *  has known rough edges with `Option<Vec<_>>`). */
export interface NapiMcpVmPolicy {
  readonly profile: string
  readonly workspace: string
  readonly allowNetwork?: boolean
  readonly networkAllowlist: string[]
  readonly hostReadAllowlist: string[]
  readonly hostWriteAllowlist: string[]
  readonly memoryMb?: number
  readonly cpuCount?: number
  readonly maxRuntimeMs?: number
  readonly bootImagePath?: string
}

/** napi-rs VM spawn spec shape. Matches `NapiVmSpawnSpec` — cwd is NOT
 *  here (guest filesystem layout is policy-driven, not per-spawn). */
export interface NapiVmSpawnSpec {
  readonly mcpId: string
  readonly command: string[]
  readonly env?: Record<string, string>
}

/** Shape of the napi-rs binding we depend on. The real
 *  `@quanta/darwin-vz-helper` exports these two symbols; the test DI
 *  seam injects a fake conforming to this interface. */
export interface NativeAppleVzBinding {
  spawn_vm_for_mcp(
    spec: NapiVmSpawnSpec,
    policy: NapiMcpVmPolicy,
  ): NapiVmSpawnResult | Promise<NapiVmSpawnResult>
  availability(): string
}

/** Closed-port DI extension over {@link McpSandboxConfig}. Tests pass
 *  `binding` (preferred — direct fake) or `bindingLoader` (controls the
 *  lazy import outcome — null = "not installed"). */
export interface NativeAppleVzConfig extends McpSandboxConfig {
  readonly binding?: NativeAppleVzBinding
  readonly bindingLoader?: () => NativeAppleVzBinding | null
}

/** Parsed availability JSON. Matches the Rust `availability()` shape. */
interface AvailabilityInfo {
  readonly available: boolean
  readonly backend: string
  readonly reason?: string
}

const parseAvailability = (raw: string): AvailabilityInfo | null => {
  try {
    const j = JSON.parse(raw) as unknown
    if (typeof j !== "object" || j === null) return null
    const obj = j as Record<string, unknown>
    const available = obj.available === true
    const backend = typeof obj.backend === "string" ? obj.backend : "passthrough"
    const reason = typeof obj.reason === "string" ? obj.reason : undefined
    return {
      available,
      backend,
      ...(reason !== undefined ? { reason } : {}),
    }
  } catch {
    return null
  }
}

/** Synchronous construction-time loader. Returns null in the scaffold —
 *  the real production load happens asynchronously in
 *  `detectNativeAppleVz()` / `dynamicLoadBinding()`. Mirrors the
 *  `landlock-native::defaultBindingLoader` rationale: avoid pulling in
 *  `node:module`/`createRequire` here so the synchronous construction
 *  path stays clean. */
const defaultBindingLoader = (): NativeAppleVzBinding | null => null

/** Async one-shot loader for the production import path. Returns the
 *  binding or null. Centralized so tests can monkey-patch without touching
 *  module-level state. Same shape as landlock-native::dynamicLoadBinding. */
const dynamicLoadBinding = async (): Promise<NativeAppleVzBinding | null> => {
  try {
    // `@quanta/darwin-vz-helper` is an OPTIONAL dep — present at runtime
    // only on darwin hosts where the install succeeded. The ts-ignore is
    // deliberate: the package may not be in node_modules (install opt-out
    // case), in which case the import throws and we degrade to null.
    // @ts-expect-error — optional dep, may not be installed
    const mod: unknown = await import("@quanta/darwin-vz-helper")
    if (mod === null || typeof mod !== "object") return null
    const m = mod as Record<string, unknown>
    const spawnFn = m.spawn_vm_for_mcp
    const availFn = m.availability
    if (typeof spawnFn !== "function" || typeof availFn !== "function") return null
    return {
      spawn_vm_for_mcp: spawnFn as NativeAppleVzBinding["spawn_vm_for_mcp"],
      availability: availFn as NativeAppleVzBinding["availability"],
    }
  } catch {
    return null
  }
}

/**
 * Probe whether `@quanta/darwin-vz-helper` is loaded AND the runtime
 * supports Apple Virtualization. Returns `null` when unavailable (binding
 * missing, framework absent / entitlements missing, runtime exception
 * during probe) — never throws.
 *
 * `registry.ts` calls this before deciding to use the native adapter;
 * `null` ⇒ fall through to the Phase 2 Lima/AppleVZ external wrapper.
 *
 * Tests inject a fake binding via `cfg.binding`. The production path uses
 * `dynamicLoadBinding()` for a one-shot dynamic import.
 */
export const detectNativeAppleVz = async (
  cfg?: NativeAppleVzConfig,
): Promise<{ backend: string } | null> => {
  // Platform gate: even with the (Linux-installed) package loadable in
  // dev, return null on non-darwin platforms. The real binding's
  // non-macOS Rust path also returns `available: false` — this is just
  // the cheap pre-check.
  const platform = cfg?.platform ?? process.platform
  if (platform !== "darwin") return null

  const binding =
    cfg?.binding ?? (cfg?.bindingLoader ? cfg.bindingLoader() : await dynamicLoadBinding())
  if (binding === null) return null
  try {
    const raw = binding.availability()
    const info = parseAvailability(raw)
    if (info === null) return null
    if (!info.available) return null
    return { backend: info.backend }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  policy mapping: McpSandboxPolicy → NapiMcpVmPolicy                */
/* ------------------------------------------------------------------ */

/** Map the typed TS policy to the napi-rs shape. Exported for unit-test
 *  visibility on the policy-mapping contract (camelCase TS → camelCase
 *  napi, which napi-rs converts to snake_case on the Rust side).
 *
 *  `workspace` is taken from `spec.cwd` (mirrors landlock-native), with a
 *  documented fallback to "/" when cwd is omitted. Phase 3.4 may tighten
 *  this — but the scaffold path must remain composable. */
export const mapPolicyToNapi = (policy: McpSandboxPolicy, workspace: string): NapiMcpVmPolicy => {
  // `allowNetwork` is derived from the presence of a non-empty
  // `networkAllowlist`. The TS policy does NOT carry an explicit boolean
  // — empty/absent allowlist = deny-all (matches Phase 2 Lima behaviour).
  // Phase 3.4 may add an explicit override field if a use case appears.
  const allowNetwork = policy.networkAllowlist !== undefined && policy.networkAllowlist.length > 0
  return {
    profile: policy.profile,
    workspace,
    ...(allowNetwork ? { allowNetwork: true } : {}),
    networkAllowlist: policy.networkAllowlist !== undefined ? [...policy.networkAllowlist] : [],
    hostReadAllowlist: policy.hostReadAllowlist !== undefined ? [...policy.hostReadAllowlist] : [],
    hostWriteAllowlist:
      policy.hostWriteAllowlist !== undefined ? [...policy.hostWriteAllowlist] : [],
    ...(policy.memoryMb !== undefined ? { memoryMb: policy.memoryMb } : {}),
    ...(policy.cpuCount !== undefined ? { cpuCount: policy.cpuCount } : {}),
    ...(policy.maxRuntimeMs !== undefined ? { maxRuntimeMs: policy.maxRuntimeMs } : {}),
    ...(policy.bootImagePath !== undefined ? { bootImagePath: policy.bootImagePath } : {}),
  }
}

const mapSpecToNapi = (spec: McpServerSpec): NapiVmSpawnSpec => ({
  mcpId: spec.id,
  command: [...spec.command],
  ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
})

const mapIpcKind = (raw: string): "stdio" | "vsock" | "named-pipe" => {
  if (raw === "vsock") return "vsock"
  if (raw === "stdio-over-ssh" || raw === "stdio") return "stdio"
  return "named-pipe"
}

/** Idempotent stop wrapper. The Phase 3.3 binding has no `stop` napi call
 *  yet (Phase 3.4); this returns a no-op stop so the handle contract holds. */
const noopStop = (): (() => Promise<void>) => {
  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    // Phase 3.4 will call binding.stop_vm(vmId) here.
  }
}

/* ------------------------------------------------------------------ */
/*  the adapter                                                        */
/* ------------------------------------------------------------------ */

/**
 * Native Apple Virtualization McpSandbox adapter. Loads the optional
 * `@quanta/darwin-vz-helper` napi-rs binding lazily; when absent every
 * `spawn()` rejects with `McpSandboxError("backend-unavailable", …)` and
 * `availability()` reports `passthrough`.
 *
 * Profile handling:
 *  - `microvm` → native VZ bring-up (Phase 3.4); Phase 3.3 scaffold
 *    raises `backend-unavailable` via the Rust `Err` path.
 *  - `container` → REJECTED with `policy-rejected` ("vz-no-container") —
 *    AVF does not provide container isolation; the registry must route
 *    container profiles to Lima or the container adapter.
 *  - `off`, `process-isolated` → REJECTED with `policy-rejected`
 *    ("wrong-backend") — bypass profiles should never reach this adapter.
 *
 * Cancellation contract: AbortSignal is NOT carried into the binding
 * (napi can't ferry it); Phase 3.4 will return a `vmId` the TS adapter
 * uses to kill via a separate napi call.
 */
export const nativeAppleVzSandbox = (cfg?: NativeAppleVzConfig): McpSandbox => {
  const binding =
    cfg?.binding ?? (cfg?.bindingLoader ? cfg.bindingLoader() : defaultBindingLoader())

  return {
    async spawn(spec: McpServerSpec, policy: McpSandboxPolicy): Promise<McpSandboxHandle> {
      // Profile gate. The native VZ backend ONLY does microvm — registry
      // routing must filter; reaching here with a non-microvm profile
      // is a wire contract bug surfaced as a typed `policy-rejected`.
      if (policy.profile === "off" || policy.profile === "process-isolated") {
        throw new McpSandboxError(
          "policy-rejected",
          `darwin-vz: bypass profile "${policy.profile}" reached native adapter (registry routing bug)`,
        )
      }
      if (policy.profile === "container") {
        throw new McpSandboxError(
          "policy-rejected",
          "darwin-vz: container profile not supported by Apple Virtualization (use Lima fallback or container adapter)",
        )
      }

      // Binding gate.
      if (binding === null) {
        throw new McpSandboxError(
          "backend-unavailable",
          "darwin-vz: @quanta/darwin-vz-helper not loaded — install the per-platform package or use Lima fallback",
        )
      }

      const workspace = spec.cwd ?? "/"
      const napiPolicy = mapPolicyToNapi(policy, workspace)
      const napiSpec = mapSpecToNapi(spec)

      let raw: NapiVmSpawnResult
      try {
        raw = await Promise.resolve(binding.spawn_vm_for_mcp(napiSpec, napiPolicy))
      } catch (e) {
        const msg = errMessage(e)
        throw new McpSandboxError(
          "backend-unavailable",
          `darwin-vz: native spawn failed (${msg})`,
          { cause: e },
        )
      }

      return {
        serverId: spec.id,
        profile: policy.profile,
        backendId: raw.vmId,
        sandboxApplied: raw.sandboxApplied,
        ...(raw.degradeReason !== undefined ? { degradeReason: raw.degradeReason } : {}),
        ipcChannel: { kind: mapIpcKind(raw.ipcKind), ref: raw.ipcRef },
        stop: noopStop(),
      }
    },

    async availability(): Promise<McpSandboxAvailability> {
      const platform = cfg?.platform ?? process.platform
      if (platform !== "darwin") {
        return {
          backend: "passthrough",
          warnings: [`darwin-vz: backend is darwin-only (platform=${platform})`],
        }
      }
      if (binding === null) {
        return {
          backend: "passthrough",
          warnings: ["darwin-vz-not-loaded — @quanta/darwin-vz-helper not installed"],
        }
      }
      try {
        const info = parseAvailability(binding.availability())
        if (info === null || !info.available) {
          return {
            backend: "passthrough",
            warnings: [`darwin-vz-unavailable${info?.reason ? `: ${info.reason}` : ""}`],
          }
        }
        return { backend: "microvm", warnings: [] }
      } catch {
        return {
          backend: "passthrough",
          warnings: ["darwin-vz: binding threw on availability()"],
        }
      }
    },
  }
}
