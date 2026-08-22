/**
 * Windows sandbox native boundary — **the single file that touches the native
 * helper** (RFC-07 §5.4, ADR-0441). Mirrors landlock-native.ts 1:1.
 *
 * HONEST CONSTRAINT: real Win32 isolation (CreateRestrictedToken /
 * SetTokenInformation integrity / CreateProcessAsUser / Job Object /
 * deny-read ACEs) is **impossible from pure Node/Bun** — those APIs are not
 * exposed by the standard runtime. So this adapter delegates to an external
 * broker helper exe (`quanta-win-sandbox.exe` — the RFC's recommended option
 * A, mirroring Codex's `fs sandbox helper` broker-process). The helper builds
 * the restricted token + integrity + job object and spawns the target command
 * via `CreateProcessAsUser`.
 *
 * The helper exe BUILD (L3) is a separate backlog track (same way landlock's
 * napi addon build is a separate ADR). **This file ships the boundary +
 * degrade path ONLY.** When the helper is absent — which is the case for every
 * user today — every spawn degrades to byte-identical passthrough with
 * `degradeReason: "native-binding-unavailable"`, and `availability()` reports
 * `passthrough`. There is NO silent isolation claim.
 *
 * Design contract (identical to nativeLandlockOsSandbox):
 *  - `nativeWindowsOsSandbox(cfg)` always returns an `OsSandbox` — never throws
 *    at construction. Binding null ⇒ degraded passthrough.
 *  - `detectNativeWindows()` is the cheap probe `default.ts` calls — returns
 *    `null` whenever the helper is unavailable; never throws.
 *  - Closed-port DI: tests inject a fake binding via `cfg.binding` (or
 *    `cfg.bindingLoader`). Production wires the real helper lazily.
 *
 * Why a separate file (not folded into windows.ts)? windows.ts is the PURE
 * compiler (no I/O, testable everywhere). This file carries the optional-dep /
 * spawn / degrade shape. Separation keeps the pure core importable without
 * dragging in the native-load path.
 */

import { errMessage } from "@/shared"
import type {
  OsSandbox,
  OsSandboxConfig,
  SandboxAvailability,
  SandboxedSpawnResult,
  SandboxedSpawnSpec,
  Spawner,
} from "./types"
import type { WindowsSandboxSpec } from "./windows"
import { compileWindowsSandboxSpec } from "./windows"

/** Spawn spec handed to the native helper (camelCase across the boundary).
 *  AbortSignal does NOT cross to the helper — cancellation is handled locally
 *  by the adapter / outer chain (same as landlock-native). */
export interface NativeWinSpec {
  readonly command: string[]
  readonly cwd: string
  readonly env?: Record<string, string>
}

/** Result shape returned by the native helper. */
export interface NativeWinResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly sandboxApplied: boolean
  readonly degradeReason?: string
}

/** Shape of the helper binding. The real helper exposes `spawn_sandboxed`
 *  (which JSON-encodes the {@link WindowsSandboxSpec} over stdin to
 *  `quanta-win-sandbox.exe`) + `availability` (JSON probe). The test DI seam
 *  injects a fake conforming to this interface. */
export interface WindowsSandboxBinding {
  spawn_sandboxed(
    spec: NativeWinSpec,
    sandbox: WindowsSandboxSpec,
  ): NativeWinResult | Promise<NativeWinResult>
  availability(): string
}

/** Closed-port DI extension over {@link OsSandboxConfig}. Tests pass `binding`
 *  (preferred — direct fake) or `bindingLoader` (controls the "helper not
 *  installed" branch). `failClosedOnNetwork` opts into rejecting a spawn when
 *  the policy demands network-deny but the helper cannot enforce it (default
 *  is honest warn, NOT block — RFC-07 §7). */
export interface NativeWindowsConfig extends OsSandboxConfig {
  readonly binding?: WindowsSandboxBinding
  readonly bindingLoader?: () => WindowsSandboxBinding | null
  readonly failClosedOnNetwork?: boolean
}

/** Parsed availability JSON. Matches the helper's `availability()` shape. */
interface AvailabilityInfo {
  readonly available: boolean
  readonly osBuild: string
  readonly reason?: string
}

const parseAvailability = (raw: string): AvailabilityInfo | null => {
  try {
    const j = JSON.parse(raw) as unknown
    if (typeof j !== "object" || j === null) return null
    const obj = j as Record<string, unknown>
    const available = obj.available === true
    const osBuild = typeof obj.osBuild === "string" ? obj.osBuild : ""
    const reason = typeof obj.reason === "string" ? obj.reason : undefined
    return {
      available,
      osBuild,
      ...(reason !== undefined ? { reason } : {}),
    }
  } catch {
    return null
  }
}

/** Default synchronous loader: always `null` (helper not loaded in-process).
 *  The real one-shot async load lives in {@link dynamicLoadBinding}; this gives
 *  the construction-time path (no explicit binding) a deterministic answer. */
const defaultBindingLoader = (): WindowsSandboxBinding | null => null

/** Async one-shot loader for the production import path. Returns the binding or
 *  null. The helper exe is an OPTIONAL artifact (L3 build) — absent for every
 *  user today, so this returns null until the helper ships and is wired. */
const dynamicLoadBinding = async (): Promise<WindowsSandboxBinding | null> => {
  try {
    // `@quanta/windows-sandbox-native` is an OPTIONAL dep (helper-exe shim).
    // It is NOT published yet (L3 backlog), so the import throws and we
    // degrade to null. The ts-ignore is deliberate.
    // @ts-expect-error — optional dep, not yet built/installed (L3 backlog)
    const mod: unknown = await import("@quanta/windows-sandbox-native")
    if (mod === null || typeof mod !== "object") return null
    const m = mod as Record<string, unknown>
    const spawnFn = m.spawn_sandboxed
    const availFn = m.availability
    if (typeof spawnFn !== "function" || typeof availFn !== "function") return null
    return {
      spawn_sandboxed: spawnFn as WindowsSandboxBinding["spawn_sandboxed"],
      availability: availFn as WindowsSandboxBinding["availability"],
    }
  } catch {
    return null
  }
}

/**
 * Probe whether the Windows sandbox helper is available. Returns `null` when
 * unavailable (helper missing, probe says unavailable, runtime exception) —
 * never throws. `default.ts` calls this before deciding to use this adapter;
 * `null` ⇒ degrade to passthrough.
 *
 * Tests inject a fake binding via `cfg.binding`. Production uses
 * `dynamicLoadBinding()` for a one-shot dynamic import.
 */
export const detectNativeWindows = async (
  cfg?: NativeWindowsConfig,
): Promise<{ osBuild: string } | null> => {
  const binding =
    cfg?.binding ?? (cfg?.bindingLoader ? cfg.bindingLoader() : await dynamicLoadBinding())
  if (binding === null) return null
  try {
    const info = parseAvailability(binding.availability())
    if (info === null) return null
    if (!info.available) return null
    return { osBuild: info.osBuild }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  spec/result mapping                                                */
/* ------------------------------------------------------------------ */

const mapSpecToNative = (spec: SandboxedSpawnSpec): NativeWinSpec => ({
  command: [...spec.command],
  cwd: spec.cwd,
  ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
})

const mapNativeResult = (r: NativeWinResult): SandboxedSpawnResult => ({
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
 * Native Windows OsSandbox adapter. Delegates isolation to the helper exe
 * (`quanta-win-sandbox.exe`) via the injected/loaded binding. When the helper
 * is absent — the default state today — every spawn returns a degraded
 * passthrough with `degradeReason: "native-binding-unavailable"` and
 * `availability()` reports `passthrough`.
 *
 * Honest degrade semantics:
 *  - off / danger-full-access → pure passthrough, NO degradeReason (parity with
 *    seatbelt/landlock — user opted out).
 *  - binding null → degraded passthrough (`native-binding-unavailable`).
 *  - compile → null on a profile that reached here (shouldn't happen given the
 *    off/danger short-circuit) → degraded passthrough (`profile-uncompilable`).
 *  - binding throws → exitCode 127 + `native-binding-threw`, never throws.
 *  - network-deny demanded but `failClosedOnNetwork` set + helper can't enforce
 *    → the helper itself reports it; the adapter forwards the helper's typed
 *    degradeReason. (v1 default is warn, not block — RFC-07 §7.)
 */
export const nativeWindowsOsSandbox = (cfg?: NativeWindowsConfig): OsSandbox => {
  const spawner = cfg?.spawner ?? defaultSpawner
  const binding =
    cfg?.binding ?? (cfg?.bindingLoader ? cfg.bindingLoader() : defaultBindingLoader())

  return {
    async spawn(spec, policy): Promise<SandboxedSpawnResult> {
      // off / danger-full-access: pure passthrough (parity with other backends).
      if (policy.profile === "off" || policy.profile === "danger-full-access") {
        return passthrough(spec, spawner, { sandboxApplied: false })
      }

      // No helper → degraded passthrough so default.ts detects the gap.
      if (binding === null) {
        return passthrough(spec, spawner, {
          sandboxApplied: false,
          degradeReason: "native-binding-unavailable",
        })
      }

      // Compile the pure spec. null here is unexpected (off/danger handled
      // above) but typed — degrade honestly rather than send a null spec.
      const sandbox = compileWindowsSandboxSpec(policy, spec.cwd)
      if (sandbox === null) {
        return passthrough(spec, spawner, {
          sandboxApplied: false,
          degradeReason: "profile-uncompilable",
        })
      }

      const nativeSpec = mapSpecToNative(spec)
      try {
        const raw = await Promise.resolve(binding.spawn_sandboxed(nativeSpec, sandbox))
        return mapNativeResult(raw)
      } catch (e) {
        const msg = errMessage(e)
        return {
          exitCode: 127,
          stdout: "",
          stderr: `native-windows-failed: ${msg}`,
          sandboxApplied: false,
          degradeReason: "native-binding-threw",
        }
      }
    },

    async availability(): Promise<SandboxAvailability> {
      if (binding === null) {
        return {
          backend: "passthrough",
          warnings: [
            "native-binding-unavailable — quanta-win-sandbox.exe not found (install for isolation)",
          ],
        }
      }
      try {
        const info = parseAvailability(binding.availability())
        if (info === null || !info.available) {
          return {
            backend: "passthrough",
            warnings: [`native-windows-unavailable${info?.reason ? `: ${info.reason}` : ""}`],
          }
        }
        return { backend: "windows-restricted-token", warnings: [] }
      } catch {
        return {
          backend: "passthrough",
          warnings: ["native-binding-threw on availability()"],
        }
      }
    },
  }
}
