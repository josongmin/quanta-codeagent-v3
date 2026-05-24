import { applyStrictKnobs, isDefaultStrict, type StrictKnobs } from "./seatbelt/strict-policy"
import type { SandboxPolicy } from "./types"

/**
 * Compile a {@link SandboxPolicy} to a Seatbelt (SBPL) profile text suitable
 * for `sandbox-exec -p '<text>'`. Pure — no I/O.
 *
 * Profile shape (mirrors Codex `codex-seatbelt-sandbox-profile` baseline +
 * adapted to our 5-arm closed enum):
 *
 *   (version 1)
 *   (deny default)
 *   ;; subprocess + tty (codex-verbatim: process-exec / process-fork allowed
 *   ;; ONLY when the profile permits new-binary exec; read-only/workspace-write
 *   ;; deny process-exec to harden against shell-out exits)
 *   ;; system framework reads (always, even read-only — runtime needs libc)
 *   (allow file-read* (subpath "/usr/lib") (subpath "/usr/share")
 *                     (subpath "/System/Library") ...)
 *   ;; per-profile FS rules
 *   (allow file-read* (subpath "<workspace>") ...extraReadPaths)
 *   (allow file-write* (subpath "<workspace>") ...extraWritePaths)   ; not on read-only
 *   ;; network
 *   (deny network*)  ; or (allow network*)
 *
 * Returns `null` for profiles that should NOT be compiled (caller passes
 * the spawn through verbatim instead): `"off"`, `"danger-full-access"`.
 *
 * Design notes (deliberate, beyond the literal spec):
 *  - `pseudo-tty` + `/dev/ptmx` always allowed → required for any interactive
 *    or pty-buffered tool (test runners, repls). Without this, even `read-only`
 *    profile breaks `bash -c 'echo hi'` on some tty-attached invocations.
 *  - `ipc-posix-sem` always allowed → glibc/libc init touches them; deny
 *    causes opaque "Operation not permitted" at libc level.
 *  - `process-fork` allowed in ALL non-off profiles → fork(2) is what
 *    `bash` itself does. Forbidding it makes the sandbox useless (the
 *    sandboxed command can't run). We deny `process-exec` of NEW binaries
 *    in read-only / workspace-write — they can fork but not exec arbitrary
 *    things, which is the syscall-level analogue of "no shell-out exits".
 *  - System framework subpaths mirror Codex's verbatim list (so things like
 *    macOS python/node can load `/Library/Apple` plist resources, codesign
 *    verification reads, timezone data, etc. without the sandbox tripping).
 *  - We escape the workspace path's `"` characters defensively even though
 *    realistic paths don't contain them; cheap insurance against an
 *    attacker-controlled workspace argument.
 */
export const compileSeatbeltProfile = (
  policy: SandboxPolicy,
  workspace: string,
  opts?: StrictKnobs,
): string | null => {
  if (policy.profile === "off" || policy.profile === "danger-full-access") {
    return null
  }

  const escWs = escapeSbpl(workspace)
  // All compiled profiles deny `process-exec` of arbitrary new binaries.
  // Kept as a const so future profile arms (e.g. a hypothetical "build-tool"
  // profile) flip it to `true` rather than rewriting the lines builder.
  const allowExec = false

  // Network: allowed when profile is *-net OR explicit override.
  const allowNetwork = policy.profile === "workspace-write-net" || policy.allowNetwork === true

  // Resolve extra paths — absolute kept verbatim, relative joined to workspace.
  const extraReads = (policy.extraReadPaths ?? []).map((p) => resolvePath(p, workspace))
  const extraWrites = (policy.extraWritePaths ?? []).map((p) => resolvePath(p, workspace))

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    ";; subprocess + tty (codex-verbatim baseline)",
    "(allow process-fork)",
    "(allow ipc-posix-sem)",
    "(allow pseudo-tty)",
    '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
    "(allow user-preference-read)",
    ";; system framework reads (always-on)",
    "(allow file-read*",
    '  (subpath "/usr/lib")',
    '  (subpath "/usr/share")',
    '  (subpath "/Library/Apple")',
    '  (subpath "/Library/Filesystems/NetFSPlugins")',
    '  (subpath "/Library/Preferences")',
    '  (subpath "/Library/Preferences/Logging")',
    '  (subpath "/System/Library/Extensions")',
    '  (subpath "/System/Library/Frameworks")',
    '  (subpath "/System/Library/PrivateFrameworks")',
    '  (subpath "/System/Library/SubFrameworks")',
    '  (subpath "/System/iOSSupport/System/Library/Frameworks")',
    '  (subpath "/private/var/db")',
    '  (subpath "/private/var/db/timezone")',
    '  (subpath "/var/db")',
    '  (literal "/etc")',
    '  (literal "/tmp")',
    '  (literal "/private/etc/localtime"))',
  ]

  // Workspace + extras for read.
  const readSubpaths: string[] = [`(subpath "${escWs}")`]
  for (const p of extraReads) readSubpaths.push(`(subpath "${escapeSbpl(p)}")`)
  lines.push(";; workspace + extra reads")
  lines.push(`(allow file-read* ${readSubpaths.join(" ")})`)

  // Writes: skipped entirely for read-only.
  if (policy.profile !== "read-only") {
    const writeSubpaths: string[] = [`(subpath "${escWs}")`]
    for (const p of extraWrites) writeSubpaths.push(`(subpath "${escapeSbpl(p)}")`)
    lines.push(";; workspace + extra writes")
    lines.push(`(allow file-write* ${writeSubpaths.join(" ")})`)
  }

  // Exec: deny by default for read-only/workspace-write/-net. (See note above.)
  if (allowExec) {
    lines.push("(allow process-exec)")
  }
  // No explicit deny line needed — deny default catches it.

  // Network.
  lines.push(allowNetwork ? "(allow network*)" : "(deny network*)")

  const baseline = `${lines.join("\n")}\n`
  if (isDefaultStrict(opts)) return baseline
  return applyStrictKnobs(baseline, opts as StrictKnobs)
}

/** Escape `"` and `\` for inclusion in an SBPL string literal. */
const escapeSbpl = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

/** Absolute paths pass through; relative paths are resolved against workspace. */
const resolvePath = (p: string, workspace: string): string => {
  if (p.startsWith("/")) return p
  const ws = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace
  return `${ws}/${p}`
}
