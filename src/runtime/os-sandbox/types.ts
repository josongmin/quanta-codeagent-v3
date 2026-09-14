/**
 * Closed enum of sandbox profile presets. Each preset compiles to an
 * OS-native policy at apply-time. Adding a new arm is a typed change —
 * compileSeatbeltProfile / defaultOsSandbox must update with it.
 *
 * Mirrors Cursor `cursorsandbox` profiles and Codex `sandbox_mode` 3-mode.
 *  - `off`                    : byte-identical legacy passthrough (default)
 *  - `read-only`              : FS read-only, no network
 *  - `workspace-write`        : FS write inside `workspace`, read outside,
 *                               no network
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
  /** Additional write-allow paths. Same resolution rules.
   *
   *  CROSS-BACKEND CONTRACT (aug-22 parity fix) — **`read-only` HONORS
   *  `extraWritePaths`.** A `read-only` profile denies writes to the
   *  *ambient* filesystem (workspace included); it does NOT revoke the
   *  narrow, caller-owned scopes named here. Every compiler
   *  ({@link compileSeatbeltProfile}, {@link compileBubblewrapArgs},
   *  {@link compileLandlockCliArgs}, {@link compileWindowsSandboxSpec})
   *  MUST emit these paths as writable on EVERY profile arm it compiles,
   *  and MUST still deny the workspace on `read-only`. Pinned for all
   *  backends at once by `tests/unit/os-sandbox-write-scope-parity-hellgate.test.ts`
   *  — do not re-derive the rule per backend.
   *
   *  Why honor (live consumer): `createReadModeTempScope`
   *  (`src/tool/bash/index.ts`) mkdtemps a scratch dir, points `TMPDIR` at
   *  it and passes it here for `bash(mode:"read")`. Shell here-docs and
   *  python/ruby `tempfile` write under `TMPDIR`, so dropping these paths
   *  turns every read-mode here-doc/`mktemp` into EACCES — and only on the
   *  hosts whose backend drops them, which is a silent, host-dependent
   *  failure rather than an honest refusal.
   *
   *  KNOWN NON-CONFORMANCE (not fixed here — Linux-only, needs a Rust
   *  build to verify): the native Landlock backend grants these paths the
   *  *profile's* access set, so on `read-only` they land read-only
   *  (`crates/linux-sandbox-native/src/policy.rs` — `extra_write_paths`
   *  loop reuses `workspace_access`). The TS mapper forwards them verbatim;
   *  the drop is on the Rust side. */
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
  /** §12.6 (jun-08 long-tail) — Codex `[sandbox_workspace_write].exclude_slash_tmp`
   *  parity. The Seatbelt baseline hardcodes a `(literal "/tmp")` read-allow
   *  (matching the Codex profile). When this is `true`, `/tmp` is OMITTED from
   *  the compiled profile so a sandboxed command cannot read `/tmp`.
   *
   *  DEFAULT-OFF / byte-identical: absent or `false` ⇒ the profile is the
   *  unchanged Codex-verbatim baseline (the `/tmp` literal stays). Only the
   *  Seatbelt (macOS) backend honors this today; the Linux/Windows backends do
   *  not enumerate `/tmp` in their baseline, so the flag is a no-op there. */
  readonly excludeTmpdir?: boolean
  /** OC-4/S7 — optional strict-knob tightening threaded to the seatbelt compiler
   *  (which the two composition-root call sites already reach via this policy).
   *  DEFAULT-OFF: `undefined` ⇒ byte-identical baseline. See {@link
   *  import("./seatbelt/strict-policy").StrictKnobs} — `readWorkspaceOnly` narrows
   *  file-content reads off `$HOME`. Honored by the macOS Seatbelt backend today. */
  readonly strict?: import("./seatbelt/strict-policy").StrictKnobs
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

/**
 * Best-effort, platform-specific signal that triggered a sandbox-denial
 * classification. For the justification prompt + OTel ONLY — NEVER an
 * auto-grant.
 *
 *   - `seatbelt-deny`   : macOS `sandbox-exec` / kernel Seatbelt deny stderr.
 *   - `landlock-eperm`  : Linux Landlock FS denial (bare EPERM/EACCES — LOW).
 *   - `seccomp-sigsys`  : Linux seccomp SIGSYS kill under our filter (HIGH).
 *   - `exit-126`        : shell "cannot execute" — a denied process-exec (HIGH).
 *   - `windows-access`  : Windows restricted-token ERROR_ACCESS_DENIED (LOW).
 *   - `heuristic`       : a residual low-confidence catch-all.
 */
export type SandboxDenialSignal =
  | "seatbelt-deny"
  | "landlock-eperm"
  | "seccomp-sigsys"
  | "exit-126"
  | "windows-access"
  | "heuristic"

/**
 * Discriminated arm describing an OS-sandbox SYSCALL DENIAL (the sandbox ran
 * AND blocked something) — distinct from a normal nonzero command failure and
 * from a `degradeReason` (the sandbox could NOT run). Produced ONLY by the
 * pure {@link classifySandboxDenial} and ONLY when `sandboxApplied === true`.
 */
export interface SandboxDenial {
  readonly kind: "sandbox-blocked"
  /** The platform-specific signal that produced the classification. */
  readonly signal: SandboxDenialSignal
  /** Confidence tier. `"high"` = an UNAMBIGUOUS signal (SIGSYS under our
   *  seccomp filter, exit-126 denied-exec, the exact Seatbelt-deny stderr
   *  PREFIX). `"low"` = an ambiguous signal (a bare EPERM / access-denied that
   *  a real non-sandbox permission error is indistinguishable from); surfaced
   *  to the user as a DECLINE-able SUGGESTION, never a silent escalation. */
  readonly confidence: "high" | "low"
}

export interface SandboxedSpawnResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Was the sandbox actually applied (vs degraded to pass-through)? */
  readonly sandboxApplied: boolean
  /** Reason for degradation. Present iff sandboxApplied===false AND
   *  policy.profile !== "off" AND policy.profile !== "danger-full-access". */
  readonly degradeReason?: string
  /** OS-sandbox SYSCALL-DENIAL discriminant (RFC jun-6). Present iff
   *  `sandboxApplied === true` AND {@link classifySandboxDenial} recognised a
   *  block signal. MUTUALLY EXCLUSIVE with `degradeReason`:
   *    - `degradeReason` = "the sandbox did NOT run (host could not enforce)".
   *    - `denialReason`  = "the sandbox RAN and BLOCKED a syscall".
   *  The two are never both present. Absent ⇒ a nonzero exit is a plain
   *  command failure (the safe default — we UNDER-detect rather than
   *  over-escalate). Only ever SET when `QUANTA_SANDBOX_ESCALATION` is on; OFF
   *  ⇒ byte-identical to the pre-RFC result shape. */
  readonly denialReason?: SandboxDenial
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
