import type { SandboxPolicy } from "./types"

/**
 * Pure compiler: SandboxPolicy → {@link WindowsSandboxSpec} (a restricted-token
 * / job-object / path-ACL specification). **Pure — no I/O, no Win32 calls.**
 * Runs identically on any OS, so the whole spec-building contract is
 * unit-testable from darwin/linux CI (the ADR-0441 testable core).
 *
 * Mirrors {@link compileSeatbeltProfile} (seatbelt.ts) structure exactly:
 *  - same `off` / `danger-full-access` → `null` contract (caller MUST NOT
 *    wrap the spawn — passthrough verbatim).
 *  - same `extraReadPaths` / `extraWritePaths` resolution (absolute verbatim,
 *    relative joined to the workspace).
 *  - same network override rule (`profile === "workspace-write-net" ||
 *    policy.allowNetwork === true`).
 *
 * HONEST SCOPE: this spec is a *declaration* of the isolation we intend to
 * enforce. The actual Win32 enforcement (CreateRestrictedToken /
 * SetTokenInformation integrity / Job Object / deny-read ACEs) lives in a
 * native helper exe (L3 backlog — see windows-native.ts). Without that helper,
 * the selection chain in default.ts degrades to byte-identical passthrough
 * with a LOUD warning. This compiler builds the spec the helper would consume;
 * it does NOT itself isolate anything.
 *
 * Windows isolation primitive (per RFC-07 §5.1, mirrors Codex
 * `windows-sandbox-rs` broker model — restricted token + low integrity +
 * deny_read_resolver + managed egress proxy; NOT AppContainer):
 *
 * | Profile               | restrictedToken | integrity | FS                            | network |
 * | --------------------- | --------------- | --------- | ----------------------------- | ------- |
 * | off                   | — (→ null)      | —         | —                             | —       |
 * | read-only             | true            | low       | all read, NO write            | deny    |
 * | workspace-write       | true            | low       | system read, workspace write  | deny    |
 * | workspace-write-net   | true            | low       | system read, workspace write  | allow   |
 * | danger-full-access    | — (→ null)      | —         | —                             | —       |
 *
 * `seccompMode` is a Linux-only field and is IGNORED here (parity with
 * landlock-native, which is the only backend that honors it).
 *
 * `memoryMb` / `timeoutMs` flow through verbatim with exactOptional spreads
 * (omitted when the policy omits them). They map to Job Object
 * `ProcessMemoryLimit` + wall-clock watchdog in the native helper; without the
 * helper neither is enforced (see windows-native.ts degrade contract).
 */
export interface WindowsSandboxSpec {
  /** Whether the helper should spawn the child under a restricted token
   *  (CreateRestrictedToken — DISABLE_MAX_PRIVILEGE + restricting SIDs).
   *  Always `true` for the compiled (non-null) arms; the field exists so a
   *  future profile arm can opt out without rewriting the builder. */
  readonly restrictedToken: boolean
  /** Mandatory integrity level the child token is lowered to. `"low"` for all
   *  current compiled arms — Low-integrity processes cannot write Medium/High
   *  objects (Windows Mandatory Integrity Control), which is the FS-write-deny
   *  backbone for the system tree. */
  readonly integrityLevel: "low" | "medium" | "untrusted"
  /** Paths granted explicit write ACLs (workspace + extraWritePaths,
   *  resolved). Empty for read-only. Verbatim path strings (no escaping — the
   *  helper receives them JSON-over-stdin, so quoting/UNC is a non-issue). */
  readonly writePaths: ReadonlyArray<string>
  /** Paths the child may read (system tree is implicit via Low integrity;
   *  this list is workspace + extraReadPaths, resolved). */
  readonly readPaths: ReadonlyArray<string>
  /** Paths the child must NOT read — `deny_read_resolver` mirror (Codex). v1
   *  carries ONLY explicit policy input (no secret-directory heuristics — see
   *  the no-heuristics memory rule). Empty unless the policy supplies extras
   *  via a future field; the array + helper plumbing are the extension point. */
  readonly denyReadPaths: ReadonlyArray<string>
  /** Whether outbound network is permitted. When `false`, the helper routes
   *  the child through the managed egress proxy (ADR-0428) or blocks connect.
   *  Without the helper, network is NOT enforced (honest degrade). */
  readonly allowNetwork: boolean
  /** Job Object ProcessMemoryLimit (MB). Omitted when the policy omits it. */
  readonly memoryMb?: number
  /** Job Object wall-clock watchdog (ms). Omitted when the policy omits it. */
  readonly timeoutMs?: number
}

/**
 * Compile a {@link SandboxPolicy} to a {@link WindowsSandboxSpec}.
 *
 * Returns `null` for `off` / `danger-full-access` — identical contract to
 * {@link compileSeatbeltProfile} / {@link compileLandlockCliArgs}: the caller
 * passes the spawn through verbatim (no wrap, no degradeReason).
 *
 * Pure: no `Date.now`, no `Math.random`, no I/O. Deterministic for any input.
 */
export const compileWindowsSandboxSpec = (
  policy: SandboxPolicy,
  workspace: string,
): WindowsSandboxSpec | null => {
  if (policy.profile === "off" || policy.profile === "danger-full-access") {
    return null
  }

  // Network: allowed when profile is *-net OR explicit override. Identical
  // rule to seatbelt.ts / landlock-cli.ts.
  const allowNetwork = policy.profile === "workspace-write-net" || policy.allowNetwork === true

  // Resolve extras — absolute verbatim, relative joined to workspace. Mirrors
  // seatbelt `resolvePath`, adapted to Windows path shapes.
  const extraReads = (policy.extraReadPaths ?? []).map((p) => resolvePath(p, workspace))
  const extraWrites = (policy.extraWritePaths ?? []).map((p) => resolvePath(p, workspace))

  // readPaths: workspace is always readable; plus extras.
  const readPaths: string[] = [workspace, ...extraReads]

  // writePaths: empty for read-only (FS write fully denied); workspace + extras
  // otherwise. read-only also drops extraWritePaths (a read-only profile means
  // no writes by definition — same as landlock-cli's silent drop).
  const writePaths: string[] = policy.profile === "read-only" ? [] : [workspace, ...extraWrites]

  return {
    restrictedToken: true,
    integrityLevel: "low",
    writePaths,
    readPaths,
    // v1: no synthesized deny-read list (no heuristics). Extension point only.
    denyReadPaths: [],
    allowNetwork,
    ...(policy.memoryMb !== undefined ? { memoryMb: policy.memoryMb } : {}),
    ...(policy.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
  }
}

/**
 * Serialize a {@link WindowsSandboxSpec} to the JSON message the native helper
 * (`quanta-win-sandbox.exe`) consumes over stdin.
 *
 * JSON-over-stdin (not argv) is deliberate (RFC-07 §5.3 / §7): it sidesteps
 * argv quoting for paths with spaces, `"`, `\`, and UNC prefixes entirely —
 * the helper hands wide-strings straight to Win32. Mirrors Codex's "encode fs
 * sandbox helper message" pattern.
 *
 * Pure / deterministic: stable key order via the spec's own field order; no
 * timestamps. Optional fields are present in the JSON only when present on the
 * spec (exactOptional preserved across the serialization).
 */
export const serializeWindowsSpec = (spec: WindowsSandboxSpec): string => JSON.stringify(spec)

/** Resolve a policy path: absolute (drive-letter, UNC, or POSIX-rooted) kept
 *  verbatim; relative joined to the workspace. Windows-aware:
 *   - `C:\foo` / `C:/foo`        → absolute (drive letter)
 *   - `\\server\share`           → absolute (UNC)
 *   - `/foo` / `\foo`            → absolute (rooted)
 *   - `sub\dir` / `sub/dir`      → relative → `<workspace>\sub\dir`
 *  No escaping is applied (JSON-over-stdin handles it downstream). */
const resolvePath = (p: string, workspace: string): string => {
  if (isAbsoluteWindowsPath(p)) return p
  const ws = stripTrailingSep(workspace)
  return `${ws}\\${p}`
}

/** Drive-letter (`C:\`, `C:/`), UNC (`\\`), or rooted (`/`, `\`) path. */
const isAbsoluteWindowsPath = (p: string): boolean => {
  if (p.startsWith("\\\\")) return true // UNC
  if (p.startsWith("/") || p.startsWith("\\")) return true // rooted
  // Drive letter: X:\ or X:/ (X = single ascii letter).
  return /^[A-Za-z]:[\\/]/.test(p)
}

/** Drop a single trailing `\` or `/` so the join doesn't double-separate. */
const stripTrailingSep = (s: string): string =>
  s.endsWith("\\") || s.endsWith("/") ? s.slice(0, -1) : s
