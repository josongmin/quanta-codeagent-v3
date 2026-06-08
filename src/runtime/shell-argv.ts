/**
 * P16 (jun-08 long-tail §P16) — platform-aware base shell argv selection.
 *
 * `runShell` historically hardcoded `["bash", "-lc", command]` with NO win32
 * branch. On Windows there is no `bash` on PATH by default, so the spawn fails
 * with an opaque ENOENT-style error that surfaces as a confusing generic shell
 * failure — a SILENT mis-behavior the operator cannot diagnose. This module is
 * the single pure decision point that selects the base argv per platform, so
 * the silent failure becomes an EXPLICIT, typed outcome.
 *
 * Design (deliberately NOT a full Windows port — just stop the silent fail):
 *  - non-win32 (darwin/linux/…) ⇒ `["bash", "-lc", command]` — BYTE-IDENTICAL
 *    to the legacy hardcode. This is the overwhelmingly common path and must
 *    not change.
 *  - win32, default (knob OFF) ⇒ a typed `{ kind: "error" }` decision. The
 *    caller surfaces an explicit `ShellResult` (exitCode 127 + actionable
 *    stderr) INSTEAD of spawning a nonexistent `bash`. The operator now learns
 *    WHY ("bash not available on win32") rather than getting a silent ENOENT.
 *  - win32, `QUANTA_WIN_SHELL=cmd` (knob opt-in) ⇒ a `cmd.exe` fallback argv
 *    (`["cmd.exe", "/d", "/s", "/c", command]` — the same invocation Node's
 *    own `child_process` uses for `shell:true` on Windows). This is an EXPLICIT
 *    operator opt-in to run commands under the native Windows shell; semantics
 *    differ from bash so it is never the silent default.
 *
 * Pure — no I/O, no env read here (the caller resolves the knob and passes the
 * already-decided `winShell` mode in). Same inputs ⇒ same output.
 */

/** Operator-selected Windows shell behavior (resolved from `QUANTA_WIN_SHELL`
 *  at the wire site; this module stays a pure function of it).
 *   - `"error"`  : default — refuse to spawn, surface a typed error.
 *   - `"cmd"`    : explicit opt-in to the `cmd.exe` fallback. */
export type WinShellMode = "error" | "cmd"

/** Outcome of the platform argv decision. Either a spawnable argv, or an
 *  explicit refusal carrying an operator-facing reason. Closed union. */
export type ShellArgvDecision =
  | { readonly kind: "argv"; readonly argv: string[] }
  | { readonly kind: "error"; readonly reason: string }

/** The legacy POSIX shell prefix — kept as a named const so the byte-identity
 *  guarantee is greppable and a future refactor cannot drift it silently. */
export const POSIX_SHELL_ARGV = (command: string): string[] => ["bash", "-lc", command]

/**
 * Resolve the win32 shell mode from `QUANTA_WIN_SHELL`. Pure; default `"error"`
 * (refuse loudly). Only `"cmd"` (case-insensitive) opts into the cmd.exe
 * fallback — every other value (unset, empty, typo) stays the safe `"error"`
 * default so an accidental enable cannot silently change shell semantics.
 *
 * Read at the wire site (NOT inside the hot non-win32 path) so non-Windows
 * spawns never even touch the env — preserving the byte-identical fast path.
 */
export const resolveWinShellMode = (
  env: Record<string, string | undefined> = process.env,
): WinShellMode => (env.QUANTA_WIN_SHELL?.trim().toLowerCase() === "cmd" ? "cmd" : "error")

/**
 * Decide the base shell argv for `command` on `platform`.
 *
 * @param command  the shell command text.
 * @param platform `process.platform` (or a test override).
 * @param winShell win32-only mode (default `"error"`). Ignored off win32.
 */
export const buildBaseShellArgv = (
  command: string,
  platform: NodeJS.Platform,
  winShell: WinShellMode = "error",
): ShellArgvDecision => {
  if (platform !== "win32") {
    // BYTE-IDENTICAL legacy path for every non-Windows host.
    return { kind: "argv", argv: POSIX_SHELL_ARGV(command) }
  }
  if (winShell === "cmd") {
    // Explicit operator opt-in. `/d` skips AutoRun, `/s` + `/c` match Node's
    // own Windows `shell:true` invocation (handles embedded quotes the way
    // cmd.exe expects). Semantics differ from bash — never the silent default.
    return { kind: "argv", argv: ["cmd.exe", "/d", "/s", "/c", command] }
  }
  // win32 default: refuse loudly instead of spawning a nonexistent bash.
  return {
    kind: "error",
    reason:
      "win32: no POSIX shell available — `bash -lc` is not portable on Windows. " +
      "Set QUANTA_WIN_SHELL=cmd to run commands via cmd.exe, or run under WSL/Git-Bash.",
  }
}
