/**
 * RFC jun-6 — `classifySandboxDenial`: detect an OS-sandbox SYSCALL DENIAL
 * SPECIFICALLY (the sandbox ran AND blocked something), distinct from a normal
 * nonzero command failure and from a degraded (couldn't-enforce) outcome.
 *
 * # The genuinely hard part — false-positive risk, stated honestly
 *
 * There is NO portable "the sandbox blocked me" exit code. A command that
 * legitimately fails with `EPERM`/`EACCES` for a NON-sandbox reason (e.g.
 * `chmod` on a root-owned file) is byte-indistinguishable from a Landlock FS
 * denial at the exitCode level. We therefore:
 *
 *   1. NEVER classify unless `sandboxApplied === true`. A degraded /
 *      unapplied sandbox can never produce a "block" — even if the COMMAND
 *      itself printed `Sandbox: deny(1)` to stderr, with no sandbox applied it
 *      is a plain failure (the load-bearing guard: §6.1).
 *   2. Split HIGH-confidence (UNAMBIGUOUS signals only — SIGSYS under our
 *      seccomp filter, exit-126 denied-exec, the EXACT Seatbelt-deny stderr
 *      PREFIX — never a substring) from LOW-confidence (a bare EPERM, which a
 *      real non-sandbox permission error mimics exactly). Low-confidence is
 *      surfaced as a DECLINE-able suggestion, never a silent escalation.
 *   3. UNDER-detect rather than over-escalate: an unrecognised nonzero exit
 *      yields `undefined` (a plain failure, no prompt).
 *
 * Because every classification only ever OFFERS an escalation the user must
 * approve (RFC §4.3, NEVER-auto invariant), the residual cost of a false
 * positive is bounded to "the user is occasionally asked a question they can
 * decline" — NEVER a silent unsandboxed run.
 *
 * # Pure
 *
 * No IO, no clock, no env. A pure function of `(result, backend)`. Fully
 * hellgate-tested (tests/unit/sandbox-escalation-*.test.ts).
 */

import type { SandboxBackend, SandboxDenial, SandboxedSpawnResult } from "./types"

/**
 * POSIX signal number for SIGSYS (bad system call). A process killed by a
 * signal exits with code `128 + signo`; under our seccomp `strict` filter a
 * SIGSYS kill is UNAMBIGUOUSLY the sandbox (no normal command raises SIGSYS).
 */
const SIGSYS = 31
const SIGSYS_EXIT = 128 + SIGSYS // 159

/** Shell "command found but cannot execute" — a denied `process-exec` under a
 *  no-exec sandbox profile surfaces here. Distinct from 127 ("not found"). */
const EXIT_CANNOT_EXECUTE = 126

/** Windows restricted-token access-denied exit (ADR-0441). LOW-confidence —
 *  a real non-sandbox access error produces the same code. */
const WIN_ACCESS_DENIED = 5

/**
 * EXACT Seatbelt-deny stderr line PREFIXES. `sandbox-exec` / the macOS kernel
 * write a recognisable diagnostic on a policy denial. We match a LINE that
 * STARTS WITH one of these (after trimming leading whitespace) — NOT a
 * substring anywhere in stderr — so a command that merely MENTIONS the word
 * "deny" or quotes a Seatbelt line in its own output is not mis-detected.
 *
 * Verified shapes:
 *   - `Sandbox: <proc>(<pid>) deny(1) file-write-data /path`  (kernel)
 *   - `sandbox-exec: ... `                                    (the wrapper)
 *   - `deny(1) ...` / `deny file-write* ...`                  (SBPL trace)
 */
const SEATBELT_DENY_PREFIXES: readonly string[] = [
  "Sandbox:",
  "sandbox-exec:",
  "deny(1)",
  "deny default",
]

/** Banner prefixes that REQUIRE an additional `deny` token to count (a bare
 *  informational `Sandbox:`/`sandbox-exec:` line without a denial is NOT a
 *  block). The remaining prefixes are themselves the denial. */
const SEATBELT_BANNER_PREFIXES = new Set(["Sandbox:", "sandbox-exec:"])
const DENY_TOKEN = /\bdeny\b/

/** Does a single (left-trimmed) line match an exact Seatbelt-deny prefix? A
 *  banner prefix additionally requires a `deny` token. */
const lineIsSeatbeltDeny = (line: string): boolean => {
  for (const prefix of SEATBELT_DENY_PREFIXES) {
    if (!line.startsWith(prefix)) continue
    if (SEATBELT_BANNER_PREFIXES.has(prefix)) {
      if (DENY_TOKEN.test(line)) return true
    } else {
      return true
    }
  }
  return false
}

/** Does ANY line of stderr START WITH an exact Seatbelt-deny prefix (and, for
 *  the banner prefixes, carry a `deny` token)? Line-anchored, prefix-only —
 *  never a free substring. */
const hasSeatbeltDenyPrefix = (stderr: string): boolean => {
  if (stderr.length === 0) return false
  for (const rawLine of stderr.split("\n")) {
    if (lineIsSeatbeltDeny(rawLine.replace(/^\s+/, ""))) return true
  }
  return false
}

/** Bare EPERM/EACCES present in stderr (LOW-confidence — a real non-sandbox
 *  permission error is indistinguishable). Word-boundary match. */
const hasEpermSignal = (stderr: string): boolean =>
  /\b(EPERM|EACCES|Operation not permitted|Permission denied)\b/.test(stderr)

/**
 * Classify a spawn result into a {@link SandboxDenial}, or `undefined` when it
 * is NOT a recognised sandbox block.
 *
 * HARD PRECONDITION: returns `undefined` whenever `sandboxApplied !== true`,
 * regardless of stderr content. A sandbox that did not run cannot block.
 *
 * Also returns `undefined` on a SUCCESS (exitCode === 0) — a zero exit is
 * never a denial.
 */
export const classifySandboxDenial = (
  result: SandboxedSpawnResult,
  backend: SandboxBackend,
): SandboxDenial | undefined => {
  // (1) The load-bearing guard: only an APPLIED sandbox can block.
  if (result.sandboxApplied !== true) return undefined
  // A degraded result should never reach here with sandboxApplied:true, but
  // belt-and-suspenders: if a degradeReason is present, this is NOT a block
  // (the two arms are mutually exclusive).
  if (result.degradeReason !== undefined) return undefined
  // (2) A zero exit is a success — never a denial.
  if (result.exitCode === 0) return undefined

  const stderr = result.stderr

  // ---- HIGH-confidence, platform-specific, UNAMBIGUOUS signals ----

  // seccomp SIGSYS kill (Linux native, strict filter) — exit 128+SIGSYS.
  // Unambiguous: no normal command raises SIGSYS; under our filter it IS us.
  if (backend === "landlock+seccomp" && result.exitCode === SIGSYS_EXIT) {
    return { kind: "sandbox-blocked", signal: "seccomp-sigsys", confidence: "high" }
  }

  // Seatbelt deny — the EXACT line-anchored stderr prefix (macOS).
  if (backend === "seatbelt" && hasSeatbeltDenyPrefix(stderr)) {
    return { kind: "sandbox-blocked", signal: "seatbelt-deny", confidence: "high" }
  }

  // exit-126 denied-exec — a no-exec profile blocking a `process-exec`. HIGH
  // for the in-sandbox FS/exec backends (seatbelt / landlock / bwrap).
  if (
    result.exitCode === EXIT_CANNOT_EXECUTE &&
    (backend === "landlock+seccomp" || backend === "bubblewrap" || backend === "seatbelt")
  ) {
    return { kind: "sandbox-blocked", signal: "exit-126", confidence: "high" }
  }

  // ---- LOW-confidence, ambiguous signals (suggestion, never auto-act) ----

  // Landlock / bwrap bare EPERM/EACCES FS denial. A real non-sandbox EPERM
  // mimics this EXACTLY — hence LOW. Surfaced as a decline-able suggestion.
  if ((backend === "landlock+seccomp" || backend === "bubblewrap") && hasEpermSignal(stderr)) {
    return { kind: "sandbox-blocked", signal: "landlock-eperm", confidence: "low" }
  }

  // Windows restricted-token ERROR_ACCESS_DENIED (exit 5). LOW — same
  // indistinguishability story as a real access error.
  if (backend === "windows-restricted-token" && result.exitCode === WIN_ACCESS_DENIED) {
    return { kind: "sandbox-blocked", signal: "windows-access", confidence: "low" }
  }

  // (3) Unrecognised nonzero exit ⇒ plain command failure (under-detect).
  return undefined
}

/** Test seam: surface the internal predicates for the false-positive hellgate
 *  (so the EXACT-prefix-not-substring property can be asserted directly). */
export const __test = {
  hasSeatbeltDenyPrefix,
  hasEpermSignal,
  SIGSYS_EXIT,
  EXIT_CANNOT_EXECUTE,
}
