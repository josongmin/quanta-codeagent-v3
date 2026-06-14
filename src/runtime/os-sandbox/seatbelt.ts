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
 *   ;; subprocess + tty (process-exec / process-fork allowed so the wrapped
 *   ;; shell and its read-only inspection commands can start)
 *   ;; file reads (read-only / workspace-write both permit reading; write and
 *   ;; network remain profile-controlled)
 *   (allow file-read*)
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
 *  - `process-fork` and `process-exec` are allowed in ALL non-off profiles:
 *    the sandbox wraps the shell process itself, so denying exec prevents
 *    `/bin/bash -lc ...` from starting. Read-only safety comes from denying
 *    writes and network, not from making the shell unspawnable.
 *  - File reads are global: `read-only` means no filesystem writes, not
 *    workspace-only reads. macOS shells otherwise abort before user code
 *    starts because dyld/libsystem probes host paths outside the old narrow
 *    framework list.
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
  // Network: allowed when profile is *-net OR explicit override.
  const allowNetwork = policy.profile === "workspace-write-net" || policy.allowNetwork === true

  // Resolve extra write paths — absolute kept verbatim, relative joined to workspace.
  const extraWrites = (policy.extraWritePaths ?? []).map((p) => resolvePath(p, workspace))

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    ";; subprocess + tty (codex-verbatim baseline)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow ipc-posix-sem)",
    "(allow pseudo-tty)",
    '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
    "(allow user-preference-read)",
    ";; file reads (read-only by write denial)",
    "(allow file-read*)",
  ]

  if (policy.excludeTmpdir === true) {
    lines.push(";; exclude tmp reads")
    lines.push('(deny file-read* (subpath "/tmp") (subpath "/private/tmp"))')
  }

  // Writes: skipped entirely for read-only.
  if (policy.profile !== "read-only") {
    const writeSubpaths: string[] = [`(subpath "${escWs}")`]
    for (const p of extraWrites) writeSubpaths.push(`(subpath "${escapeSbpl(p)}")`)
    lines.push(";; workspace + extra writes")
    lines.push(`(allow file-write* ${writeSubpaths.join(" ")})`)
  }

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
