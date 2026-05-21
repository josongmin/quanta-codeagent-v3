/**
 * Dotfile-skipping shell launch (Tier-0 absorption #0-2). Approximates macOS
 * `POSIX_SPAWN_SETDISCLAIM` for in-process spawns by selecting shell flags
 * that decline to read the user's startup files (`~/.bashrc`, `~/.zshrc`,
 * `~/.profile`). Without this, every bash tool call inside the agent runs
 * the user's full interactive init script — a hijacked dotfile can then
 * observe the agent's child env and piggy-back on any process the agent
 * subsequently spawns.
 *
 * What this DOES guarantee:
 *   - The selected shell does not source the user's startup files for THIS
 *     command (verified per-shell by the unit tests).
 *
 * What this does NOT guarantee:
 *   - Process-level entitlement isolation. Node/Bun cannot replicate the
 *     macOS POSIX_SPAWN_SETDISCLAIM bit from JS; the disclaim is a functional
 *     approximation via shell flags, not a kernel-enforced boundary.
 *
 * Slice discipline: pure leaf module. No imports from any other slice.
 */

export type ShellInterp = "bash" | "zsh" | "sh"

export const SHELL_INTERPS = ["bash", "zsh", "sh"] as const satisfies readonly ShellInterp[]

const SHELL_INTERP_SET: ReadonlySet<string> = new Set<string>(SHELL_INTERPS)

export const isShellInterp = (s: string): s is ShellInterp => SHELL_INTERP_SET.has(s)

/** Build the argv used to invoke `shell` with `command` while skipping all
 *  user-dotfile sourcing.
 *   - `bash`: `--noprofile --norc -c` (skips both login + interactive rcs)
 *   - `zsh`:  `-f -c`                  (alias for `NO_RCS` — skips zshenv/rc/login)
 *   - `sh`:   `-c`                     (POSIX sh does not source dotfiles in
 *                                       non-login non-interactive mode)
 *
 * The caller is responsible for quoting / escaping `command` if it must be
 * treated as a single token — this function passes it through verbatim. */
export const disclaimedShellArgv = (
  shell: ShellInterp,
  command: string,
): readonly string[] => {
  switch (shell) {
    case "bash":
      return ["bash", "--noprofile", "--norc", "-c", command]
    case "zsh":
      return ["zsh", "-f", "-c", command]
    case "sh":
      return ["sh", "-c", command]
  }
}

/** Convenience for the default sandbox shell (bash). */
export const defaultDisclaimedBashArgv = (command: string): readonly string[] =>
  disclaimedShellArgv("bash", command)
