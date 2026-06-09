/**
 * P16 → ADR-0529 — cross-platform base shell argv selection.
 *
 * `runShell` historically hardcoded `["bash", "-lc", command]` with NO win32
 * branch. P16 added a minimal guard (loud-refuse on win32, cmd.exe on explicit
 * opt-in). ADR-0529 elevates that to a real cross-platform layer: a POSIX-FIRST
 * discovery ladder so a Git-Bash/WSL host runs the SAME byte-identical
 * `["bash","-lc",cmd]` path as darwin/linux (security parser, snapshot, quoting
 * all unchanged), falling back to PowerShell then cmd.exe only when no POSIX
 * shell exists.
 *
 * SOTA++ testability: the ladder is a PURE function of an injected {@link
 * ShellProbe} (discovered shell paths), and {@link discoverShells} takes an
 * injected `which` — so EVERY win32 decision branch is unit-testable ON DARWIN.
 * Only the real spawn is platform-bound (the genuine, documented limit).
 *
 * Pure — no I/O, no env read in {@link buildBaseShellArgv} (the caller resolves
 * the knob + probe and passes them in). Same inputs ⇒ same output.
 */

/** Operator-selected Windows shell behavior (resolved from `QUANTA_WIN_SHELL`).
 *   - `"error"` : default — refuse to spawn, surface a typed error (P16).
 *   - `"cmd"`   : explicit cmd.exe fallback (P16).
 *   - `"auto"`  : POSIX-first discovery ladder (bash → pwsh → cmd → error).
 *   - `"bash"`  : explicit POSIX (assumes bash/Git-Bash/WSL on PATH).
 *   - `"pwsh"`  : explicit PowerShell. */
export type WinShellMode = "error" | "cmd" | "auto" | "bash" | "pwsh"

/** Which shell dialect the chosen argv runs under — drives dialect-aware
 *  security (ADR-0529 L2) and snapshot selection (L3). `posix` == the legacy
 *  bash path (Git-Bash/WSL included). */
export type ShellDialect = "posix" | "powershell" | "cmd"

/** Outcome of the platform argv decision. Either a spawnable argv (tagged with
 *  its dialect), or an explicit refusal carrying an operator-facing reason. */
export type ShellArgvDecision =
  | { readonly kind: "argv"; readonly argv: string[]; readonly dialect: ShellDialect }
  | { readonly kind: "error"; readonly reason: string }

/** Discovered shell paths (null = not on PATH). Produced by the impure {@link
 *  discoverShells}; consumed PURELY by the ladder so it stays darwin-testable. */
export interface ShellProbe {
  readonly bash: string | null
  readonly pwsh: string | null
  readonly cmd: string | null
}

/** The legacy POSIX shell prefix — kept as a named const so the byte-identity
 *  guarantee is greppable and a future refactor cannot drift it silently. */
export const POSIX_SHELL_ARGV = (command: string): string[] => ["bash", "-lc", command]

const posixDecision = (command: string): ShellArgvDecision => ({
  kind: "argv",
  argv: POSIX_SHELL_ARGV(command),
  dialect: "posix",
})
const pwshDecision = (command: string, exe: string): ShellArgvDecision => ({
  kind: "argv",
  // `-NoProfile -NonInteractive` = no $PROFILE side-effects, no prompt hang —
  // the PowerShell analogue of `bash -lc`'s non-interactive one-shot.
  argv: [exe, "-NoProfile", "-NonInteractive", "-Command", command],
  dialect: "powershell",
})
const cmdDecision = (command: string): ShellArgvDecision => ({
  kind: "argv",
  // `/d` skips AutoRun; `/s` + `/c` match Node's own Windows `shell:true`
  // invocation (handles embedded quotes the way cmd.exe expects).
  argv: ["cmd.exe", "/d", "/s", "/c", command],
  dialect: "cmd",
})

/** The typed win32 refusal. Mentions every opt-in (auto/bash/pwsh/cmd) but keeps
 *  the P16 `QUANTA_WIN_SHELL=cmd` example so existing callers/tests still match. */
const winError = (): ShellArgvDecision => ({
  kind: "error",
  reason:
    "win32: no POSIX shell selected — `bash -lc` is not portable on Windows. " +
    "Set QUANTA_WIN_SHELL=auto to auto-detect a shell (Git-Bash/WSL → PowerShell → " +
    "cmd.exe), or pick one explicitly with QUANTA_WIN_SHELL=bash / =pwsh / =cmd " +
    "(e.g. QUANTA_WIN_SHELL=cmd for cmd.exe), or run under WSL/Git-Bash.",
})

/**
 * Resolve the win32 shell mode from `QUANTA_WIN_SHELL`. Pure; default `"error"`
 * (refuse loudly). Recognizes `cmd|auto|bash|pwsh` (case-insensitive, trimmed) —
 * every other value (unset, empty, typo, `"powershell"`) stays the safe
 * `"error"` default so an accidental/misspelled enable cannot silently change
 * shell semantics. Read at the wire site (NOT inside the hot non-win32 path).
 */
export const resolveWinShellMode = (
  env: Record<string, string | undefined> = process.env,
): WinShellMode => {
  const v = env.QUANTA_WIN_SHELL?.trim().toLowerCase()
  return v === "cmd" || v === "auto" || v === "bash" || v === "pwsh" ? v : "error"
}

/**
 * Decide the base shell argv for `command` on `platform`.
 *
 * @param command  the shell command text.
 * @param platform `process.platform` (or a test override).
 * @param winShell win32-only mode (default `"error"`). Ignored off win32.
 * @param probe    discovered shell paths — REQUIRED for `auto` (the ladder
 *                 picks from it). Ignored off win32 and for non-auto modes.
 */
export const buildBaseShellArgv = (
  command: string,
  platform: NodeJS.Platform,
  winShell: WinShellMode = "error",
  probe?: ShellProbe,
): ShellArgvDecision => {
  if (platform !== "win32") {
    // BYTE-IDENTICAL legacy path for every non-Windows host (now tagged posix).
    return posixDecision(command)
  }
  switch (winShell) {
    case "cmd":
      return cmdDecision(command)
    case "bash":
      // Explicit POSIX: assumes bash/Git-Bash/WSL on PATH — the spawn surfaces
      // ENOENT honestly if it is not (no silent guess beyond the operator's pick).
      return posixDecision(command)
    case "pwsh":
      return pwshDecision(command, probe?.pwsh ?? "pwsh")
    case "auto": {
      // POSIX-FIRST ladder. No probe ⇒ cannot discover ⇒ refuse (never guess).
      if (probe === undefined) return winError()
      if (probe.bash !== null) return posixDecision(command)
      if (probe.pwsh !== null) return pwshDecision(command, probe.pwsh)
      if (probe.cmd !== null) return cmdDecision(command)
      return winError()
    }
    default:
      // win32 default ("error"): refuse loudly instead of spawning a nonexistent bash.
      return winError()
  }
}

/** Default `which` — Bun resolves a binary name against PATH (null when absent). */
const bunWhich = (name: string): string | null => Bun.which(name)

/**
 * Discover the available shells on the current host. IMPURE (PATH lookup via the
 * injected `which`, defaulting to `Bun.which`) — kept separate from the pure
 * ladder so the ladder stays darwin-testable. `pwsh` prefers PowerShell Core
 * (`pwsh`) and falls back to Windows PowerShell (`powershell`); `cmd` prefers
 * the `cmd.exe` name and falls back to bare `cmd`.
 */
export const discoverShells = (
  which: (name: string) => string | null = bunWhich,
): ShellProbe => ({
  bash: which("bash"),
  pwsh: which("pwsh") ?? which("powershell"),
  cmd: which("cmd.exe") ?? which("cmd"),
})
