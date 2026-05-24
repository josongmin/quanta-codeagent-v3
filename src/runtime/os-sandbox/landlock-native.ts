/**
 * Linux sandbox Phase 3 — **native Landlock + seccomp** via the napi-rs
 * binding `@quanta/linux-sandbox-native` (ADR-0175).
 *
 * Mirrors Codex `codex-linux-sandbox` (in-process landlock crate). Loaded
 * as an OPTIONAL dependency — when the package is not installed (non-Linux
 * host, install opt-out, unsupported arch), this adapter degrades cleanly
 * and `default.ts` falls through to the Phase 2 external-binary wrapper
 * (`bwrap` / `landlock-cli`, ADR-0150 / ADR-0159).
 *
 * Design contract:
 *  - `nativeLandlockOsSandbox(cfg)` always returns an `OsSandbox` — never
 *    throws at construction. When the binding can't be loaded, every
 *    `spawn()` returns a degraded result with `degradeReason:
 *    "native-binding-unavailable"`; the caller chain in `default.ts`
 *    checks `availability()` (cheap) to decide whether to use this
 *    adapter or fall through to Phase 2.
 *  - `detectNativeLandlock()` is the cheap probe used by `default.ts` —
 *    returns `null` whenever the binding is unavailable OR the kernel
 *    reports ABI=0; never throws.
 *  - Closed-port DI: tests inject a fake binding via `cfg.binding` (or
 *    `cfg.bindingLoader`) — production wires the real
 *    `@quanta/linux-sandbox-native` lazily.
 *
 * Why a separate adapter file (not folded into `linux.ts`)? The Phase 2
 * adapter is shell-out (deterministic argv, no node-gyp). Folding native
 * into it would force every Linux user through the napi-rs import path
 * even when the package isn't installed — `linux.ts` would gain a
 * try/catch + `node-resolve` shape it shouldn't have to carry. Separate
 * file = separate fallback tier in `default.ts`.
 */

import type {
  OsSandbox,
  OsSandboxConfig,
  SandboxAvailability,
  SandboxedSpawnResult,
  SandboxedSpawnSpec,
  SandboxPolicy,
  Spawner,
} from "./types"

/** napi-rs spawn result shape (camelCase across the napi boundary). */
export interface NapiSpawnResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly sandboxApplied: boolean
  readonly degradeReason?: string
}

/** napi-rs SandboxPolicy shape (camelCase across napi boundary; required
 *  fields defaulted to `[]` rather than absent — see lib.rs doc). */
export interface NapiSandboxPolicy {
  readonly profile: string
  readonly workspace: string
  readonly extraReadPaths: string[]
  readonly extraWritePaths: string[]
  readonly allowNetwork?: boolean
  readonly timeoutMs?: number
  readonly memoryMb?: number
}

/** napi-rs SandboxedSpawnSpec shape. AbortSignal does NOT cross napi —
 *  the TS adapter handles cancellation locally by killing the child. */
export interface NapiSandboxedSpawnSpec {
  readonly command: string[]
  readonly cwd: string
  readonly env?: Record<string, string>
}

/** Shape of the napi-rs binding we depend on. The real
 *  `@quanta/linux-sandbox-native` exports these two symbols; the test DI
 *  seam injects a fake conforming to this interface. */
export interface NativeLandlockBinding {
  spawn_sandboxed(
    spec: NapiSandboxedSpawnSpec,
    policy: NapiSandboxPolicy,
  ): NapiSpawnResult | Promise<NapiSpawnResult>
  availability(): string
}

/** Closed-port DI extension over {@link OsSandboxConfig}. Tests pass
 *  `binding` (preferred — direct fake) or `bindingLoader` (controls the
 *  lazy import outcome — null = "not installed"). */
export interface NativeLandlockConfig extends OsSandboxConfig {
  readonly binding?: NativeLandlockBinding
  readonly bindingLoader?: () => NativeLandlockBinding | null
}

/** Parsed availability JSON. Matches the Rust `availability()` shape. */
interface AvailabilityInfo {
  readonly available: boolean
  readonly kernelVersion: string
  readonly abiSupported: number
  readonly reason?: string
}

const parseAvailability = (raw: string): AvailabilityInfo | null => {
  try {
    const j = JSON.parse(raw) as unknown
    if (typeof j !== "object" || j === null) return null
    const obj = j as Record<string, unknown>
    const available = obj.available === true
    const kernelVersion = typeof obj.kernelVersion === "string" ? obj.kernelVersion : ""
    const abiSupported = typeof obj.abiSupported === "number" ? obj.abiSupported : 0
    const reason = typeof obj.reason === "string" ? obj.reason : undefined
    return {
      available,
      kernelVersion,
      abiSupported,
      ...(reason !== undefined ? { reason } : {}),
    }
  } catch {
    return null
  }
}

/** Default loader: lazy `await import(...)` of the optional dep. Returns
 *  `null` on any failure (package missing, ABI mismatch, runtime throw)
 *  so the caller can degrade. Production-only path; tests override via
 *  `cfg.binding` / `cfg.bindingLoader`. */
const defaultBindingLoader = (): NativeLandlockBinding | null => {
  try {
    // Synchronous require-style import via createRequire would couple us
    // to node:module; instead we rely on the test seam in production and
    // expose only the typed `null` path here. The first real load happens
    // through `detectNativeLandlock` which is async — that's where the
    // dynamic import lives. This function exists so the construction-time
    // path (`nativeLandlockOsSandbox` without an explicit binding) has a
    // deterministic synchronous answer: not loaded.
    return null
  } catch {
    return null
  }
}

/** Async one-shot loader for the production import path. Returns the
 *  binding or null. Centralized so tests can monkey-patch without touching
 *  module-level state (they use `cfg.binding` instead — this is the
 *  production-only path). */
const dynamicLoadBinding = async (): Promise<NativeLandlockBinding | null> => {
  try {
    // `@quanta/linux-sandbox-native` is an OPTIONAL dep — present at
    // runtime only on Linux hosts where the install succeeded. The
    // ts-ignore is deliberate: the package may not be in node_modules
    // (the install opt-out case), in which case the import throws and
    // we degrade to null.
    // @ts-ignore — optional dep, may not be installed
    const mod: unknown = await import("@quanta/linux-sandbox-native")
    if (mod === null || typeof mod !== "object") return null
    const m = mod as Record<string, unknown>
    const spawnFn = m.spawn_sandboxed
    const availFn = m.availability
    if (typeof spawnFn !== "function" || typeof availFn !== "function") return null
    return {
      spawn_sandboxed: spawnFn as NativeLandlockBinding["spawn_sandboxed"],
      availability: availFn as NativeLandlockBinding["availability"],
    }
  } catch {
    return null
  }
}

/**
 * Probe whether `@quanta/linux-sandbox-native` is loaded and the kernel
 * supports Landlock. Returns `null` when unavailable (binding missing,
 * kernel too old, runtime exception during probe) — never throws.
 *
 * `default.ts` calls this before deciding to use the native adapter;
 * `null` ⇒ fall through to the Phase 2 wrapper.
 *
 * Tests inject a fake binding via `cfg.binding`. The production path uses
 * `dynamicLoadBinding()` for a one-shot dynamic import.
 */
export const detectNativeLandlock = async (
  cfg?: NativeLandlockConfig,
): Promise<{ abi: number; kernelVersion: string } | null> => {
  const binding =
    cfg?.binding ?? (cfg?.bindingLoader ? cfg.bindingLoader() : await dynamicLoadBinding())
  if (binding === null) return null
  try {
    const raw = binding.availability()
    const info = parseAvailability(raw)
    if (info === null) return null
    if (!info.available) return null
    if (info.abiSupported <= 0) return null
    return { abi: info.abiSupported, kernelVersion: info.kernelVersion }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  policy mapping: SandboxPolicy → NapiSandboxPolicy                 */
/* ------------------------------------------------------------------ */

/** Map the typed TS policy to the napi-rs shape. Exported for unit-test
 *  visibility on the policy-mapping contract (camelCase TS → camelCase
 *  napi, which napi-rs converts to snake_case on the Rust side). */
export const mapPolicyToNapi = (
  policy: SandboxPolicy,
  workspace: string,
): NapiSandboxPolicy => ({
  profile: policy.profile,
  workspace,
  extraReadPaths: policy.extraReadPaths ? [...policy.extraReadPaths] : [],
  extraWritePaths: policy.extraWritePaths ? [...policy.extraWritePaths] : [],
  ...(policy.allowNetwork !== undefined ? { allowNetwork: policy.allowNetwork } : {}),
  ...(policy.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
})

const mapSpecToNapi = (spec: SandboxedSpawnSpec): NapiSandboxedSpawnSpec => ({
  command: [...spec.command],
  cwd: spec.cwd,
  ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
})

const mapNapiResult = (r: NapiSpawnResult): SandboxedSpawnResult => ({
  exitCode: r.exitCode,
  stdout: r.stdout,
  stderr: r.stderr,
  sandboxApplied: r.sandboxApplied,
  ...(r.degradeReason !== undefined ? { degradeReason: r.degradeReason } : {}),
})

/* ------------------------------------------------------------------ */
/*  passthrough for off / danger / unavailable                        */
/* ------------------------------------------------------------------ */

const passthrough = async (
  spec: SandboxedSpawnSpec,
  spawner: Spawner,
  meta: { sandboxApplied: boolean; degradeReason?: string },
): Promise<SandboxedSpawnResult> => {
  const opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal } = {
    cwd: spec.cwd,
    ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
    ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
  }
  try {
    const r = await spawner([...spec.command], opts)
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

const defaultSpawner: Spawner = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
}

/* ------------------------------------------------------------------ */
/*  the adapter                                                        */
/* ------------------------------------------------------------------ */

/**
 * Native Landlock + seccomp OsSandbox adapter. Loads the optional
 * `@quanta/linux-sandbox-native` napi-rs binding lazily; when absent,
 * every spawn returns a degraded passthrough with `degradeReason:
 * "native-binding-unavailable"` and `availability()` reports
 * `passthrough`.
 *
 * Cancellation contract: AbortSignal flows through `spec.signal`. The
 * binding does not see the signal directly (napi can't ferry it); the
 * adapter races `signal` against the binding call and kills the child
 * via its returned PID handle in Phase 3.1. **Scaffold note**: the
 * scaffold binding returns immediately (no real fork), so cancellation
 * is a no-op until Phase 3.1 — documented here so the contract is
 * explicit.
 */
export const nativeLandlockOsSandbox = (cfg?: NativeLandlockConfig): OsSandbox => {
  const spawner = cfg?.spawner ?? defaultSpawner
  const binding =
    cfg?.binding ?? (cfg?.bindingLoader ? cfg.bindingLoader() : defaultBindingLoader())

  return {
    async spawn(spec, policy): Promise<SandboxedSpawnResult> {
      // off / danger-full-access: pass-through (parity with Phase 2).
      if (policy.profile === "off" || policy.profile === "danger-full-access") {
        return passthrough(spec, spawner, { sandboxApplied: false })
      }

      // No binding loaded → degraded passthrough so the upstream chain
      // (default.ts) can detect the gap and route to Phase 2.
      if (binding === null) {
        return passthrough(spec, spawner, {
          sandboxApplied: false,
          degradeReason: "native-binding-unavailable",
        })
      }

      const napiPolicy = mapPolicyToNapi(policy, spec.cwd)
      const napiSpec = mapSpecToNapi(spec)
      try {
        const raw = await Promise.resolve(binding.spawn_sandboxed(napiSpec, napiPolicy))
        return mapNapiResult(raw)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          exitCode: 127,
          stdout: "",
          stderr: `native-landlock-failed: ${msg}`,
          sandboxApplied: false,
          degradeReason: "native-binding-threw",
        }
      }
    },

    async availability(): Promise<SandboxAvailability> {
      if (binding === null) {
        return {
          backend: "passthrough",
          warnings: ["native-binding-unavailable — @quanta/linux-sandbox-native not loaded"],
        }
      }
      try {
        const info = parseAvailability(binding.availability())
        if (info === null || !info.available) {
          return {
            backend: "passthrough",
            warnings: [
              `native-landlock-unavailable${info?.reason ? `: ${info.reason}` : ""}`,
            ],
          }
        }
        return { backend: "landlock+seccomp", warnings: [] }
      } catch {
        return {
          backend: "passthrough",
          warnings: ["native-binding-threw on availability()"],
        }
      }
    },
  }
}
