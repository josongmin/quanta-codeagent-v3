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
 *   (allow file-write* (subpath "<workspace>") ...extraWritePaths)   ; read-only only honors explicit extraWritePaths
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
  const extraWrites = unique(
    (policy.extraWritePaths ?? [])
      .map((p) => resolvePath(p, workspace))
      .flatMap((p) => seatbeltPathAliases(p)),
  )

  // Resolve extra read paths (same resolution rule as write paths).
  const extraReads = unique((policy.extraReadPaths ?? []).map((p) => resolvePath(p, workspace)))

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

  // Extra read paths (explicitly called-out; the global allow file-read* above
  // already permits them but listing them makes the profile auditable).
  if (extraReads.length > 0) {
    lines.push(";; extra read paths")
    for (const p of extraReads) {
      lines.push(`(allow file-read* (subpath "${escapeSbpl(p)}"))`)
    }
  }

  const writeLine = writeAllowLine(policy.profile, escWs, extraWrites)
  if (writeLine !== null) {
    lines.push(";; workspace + extra writes")
    lines.push(writeLine)
  }

  // Network.
  lines.push(allowNetwork ? "(allow network*)" : "(deny network*)")

  const baseline = `${lines.join("\n")}\n`
  if (isDefaultStrict(opts)) return baseline
  return applyStrictKnobs(baseline, opts as StrictKnobs)
}

/**
 * The single `(allow file-write* ...)` line for this profile, or `null` when
 * nothing at all is writable.
 *
 * A unit because it is where the cross-backend write-scope contract documented
 * on {@link SandboxPolicy.extraWritePaths} is decided: `read-only` must deny the
 * AMBIENT filesystem — the workspace included — while STILL granting the narrow
 * caller-owned scopes (a read-mode TMPDIR). Both halves in one place, so a
 * reader can see that read-only neither gains the workspace nor loses TMPDIR.
 */
const writeAllowLine = (
  profile: SandboxPolicy["profile"],
  escWs: string,
  extraWrites: readonly string[],
): string | null => {
  if (profile === "read-only" && extraWrites.length === 0) return null
  const writeSubpaths: string[] = profile !== "read-only" ? [`(subpath "${escWs}")`] : []
  for (const p of extraWrites) {
    const escaped = escapeSbpl(p)
    writeSubpaths.push(`(literal "${escaped}")`, `(subpath "${escaped}")`)
  }
  return `(allow file-write* ${writeSubpaths.join(" ")})`
}

/** Escape `"` and `\` for inclusion in an SBPL string literal. */
const escapeSbpl = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

/** Absolute paths pass through; relative paths are resolved against workspace. */
const resolvePath = (p: string, workspace: string): string => {
  if (p.startsWith("/")) return p
  const ws = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace
  return `${ws}/${p}`
}

const unique = (paths: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

const seatbeltPathAliases = (path: string): string[] => {
  if (path === "/tmp") return [path, "/private/tmp"]
  if (path.startsWith("/tmp/")) return [path, `/private${path}`]
  if (path === "/private/tmp") return [path, "/tmp"]
  if (path.startsWith("/private/tmp/")) return [path, path.slice("/private".length)]
  return [path]
}
