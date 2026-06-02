/**
 * Closed enum of sandbox profile presets. Each preset compiles to an
 * OS-native policy at apply-time. Adding a new arm is a typed change —
 * compileSeatbeltProfile / defaultOsSandbox must update with it.
 *
 * Mirrors Cursor `cursorsandbox` profiles and Codex `sandbox_mode` 3-mode.
 *  - `off`                    : byte-identical legacy passthrough (default)
 *  - `read-only`              : FS read-only, no network, no new-binary exec
 *  - `workspace-write`        : FS write inside `workspace`, read outside,
 *                               no network, no exec of new binaries
 *  - `workspace-write-net`    : workspace-write + network allow
 *  - `danger-full-access`     : explicit opt-in pass-through (warning surfaced)
 */
export type SandboxProfile =
  | "off"
  | "read-only"
  | "workspace-write"
  | "workspace-write-net"
  | "danger-full-access"

/**
 * Declarative sandbox policy. The OS-native enforcer compiles this to a
 * Seatbelt profile (macOS) or Landlock+seccomp ruleset (linux, Phase 2).
 *
 * exactOptionalPropertyTypes: omitted fields must be absent — never
 * `undefined`-set. Spec writers compose policies with conditional spreads:
 *   const p: SandboxPolicy = { profile, ...(extra ? { extraReadPaths: extra } : {}) }
 */
export interface SandboxPolicy {
  readonly profile: SandboxProfile
  /** Additional read-allow paths. Absolute paths preserved verbatim;
   *  workspace-relative resolved against the policy's workspace. */
  readonly extraReadPaths?: ReadonlyArray<string>
  /** Additional write-allow paths. Same resolution rules. */
  readonly extraWritePaths?: ReadonlyArray<string>
  /** Network policy override — when `profile` doesn't already allow.
   *  When the profile already allows network (e.g. `workspace-write-net`,
   *  `danger-full-access`), this field has no effect. */
  readonly allowNetwork?: boolean
  /** Wall-clock cap (ms). The sandbox aborts the spawn signal past this. */
  readonly timeoutMs?: number
  /** Memory cap (MB). Enforced by the native Linux adapter via
   *  `RLIMIT_AS + RLIMIT_DATA` in the child's `pre_exec`; ignored on
   *  backends that don't carry it (Phase 2 bwrap/landlock-cli, Seatbelt).
   *  ADR-0191 Phase 3.2. */
  readonly memoryMb?: number
  /** Seccomp mode for the native Linux adapter: `"strict"` (default —
   *  Phase 3.2 default-deny allowlist) or `"lax"` (Phase 3.1 wire,
   *  diagnostic / debug only). Other backends ignore this field.
   *  Defaults to `"strict"` when the adapter sees `undefined`.
   *  Linux-only — the Windows backend (ADR-0441) IGNORES this field. */
  readonly seccompMode?: "lax" | "strict"
}

export interface SandboxedSpawnSpec {
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

export type SandboxBackend =
  | "seatbelt"
  | "bubblewrap"
  | "landlock+seccomp"
  // ADR-0441 — Windows broker-helper backend (restricted token + low
  // integrity + Job Object + deny-read resolver). Reported by `availability()`
  // only when the native helper (`quanta-win-sandbox.exe`) is present; absent
  // ⇒ `passthrough`.
  | "windows-restricted-token"
  | "passthrough"

export interface SandboxedSpawnResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Was the sandbox actually applied (vs degraded to pass-through)? */
  readonly sandboxApplied: boolean
  /** Reason for degradation. Present iff sandboxApplied===false AND
   *  policy.profile !== "off" AND policy.profile !== "danger-full-access". */
  readonly degradeReason?: string
}

export interface SandboxAvailability {
  readonly backend: SandboxBackend
  readonly warnings: ReadonlyArray<string>
}

/**
 * Port. Closed-port DI: production wires `defaultOsSandbox()`; tests inject
 * a fake spawner via {@link OsSandboxConfig}.
 *
 * NO-THROW contract: spawn/sandbox failures never throw. The result carries
 * `exitCode === 127` + a descriptive `stderr`. The only typed throw class
 * ({@link OsSandboxError}) exists for callers who want to opt-in via try
 * around the spawner config they pass — not the surface itself.
 */
export interface OsSandbox {
  spawn(spec: SandboxedSpawnSpec, policy: SandboxPolicy): Promise<SandboxedSpawnResult>
  availability(): Promise<SandboxAvailability>
}

/** Fake spawner shape — async, returns the buffered result. Real wire uses
 *  `Bun.spawn`. exactOptional: omit `env` rather than pass `undefined`. */
export type Spawner = (
  argv: string[],
  opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export interface OsSandboxConfig {
  readonly spawner?: Spawner
  /** Platform override — tests pass `"linux"`/`"darwin"`/`"win32"`. */
  readonly platform?: NodeJS.Platform
  /** Binary lookup. Default checks PATH via `which`. Returns absolute path
   *  or null when missing. */
  readonly which?: (binary: string) => Promise<string | null>
}

export class OsSandboxError extends Error {
  constructor(
    public readonly code: "sandbox-unavailable" | "policy-rejected" | "spawn-failed",
    message: string,
  ) {
    super(message)
    this.name = "OsSandboxError"
  }
}
