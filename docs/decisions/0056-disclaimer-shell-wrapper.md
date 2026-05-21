# ADR-0056 — Disclaimer shell wrapper (dotfile-skipping spawn)

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0006 (LocalSandbox env scrub + cwd jail), [[claude-desktop-1-7196-catalog]] §POSIX_SPAWN_SETDISCLAIM, [[cc-v2-sota-absorption]] (Tier-0 absorption #0-2)

## Context

Claude Desktop 1.7196.3 wraps user-shell launches with
`posix_spawnp` + `POSIX_SPAWN_SETDISCLAIM` (macOS-only). The effect:
the spawned shell does NOT inherit the caller's entitlements / TCC grants,
so a hijacked `~/.zshrc` cannot piggy-back on the agent's identity. POSIX_SPAWN_SETDISCLAIM is not exposed to Node/Bun, so an in-process JS
agent cannot replicate the kernel-level bit.

What v3 CAN replicate is the OBSERVABLE invariant — user dotfiles do not
execute in the child — by selecting shell flags that decline to source the
init scripts. This is the FUNCTIONAL approximation, not a kernel boundary.

The prior `LocalSandbox.run()` used `bash -lc <command>`. `-l` makes bash
a login shell, which sources `/etc/profile`, `~/.bash_profile`, `~/.profile`,
and (via `~/.bashrc` from there) the user's full interactive init script.
A malicious `~/.bashrc` runs on EVERY agent shell call.

## Decision

1. `src/runtime/shell-disclaim.ts` — pure leaf module exporting `disclaimedShellArgv(shell, command)` for the three supported interps:
   - `bash`: `--noprofile --norc -c` (skips login + interactive rcs)
   - `zsh`:  `-f -c` (alias for `NO_RCS` — skips zshenv/rc/login)
   - `sh`:   `-c` (POSIX sh does not source dotfiles in non-login non-interactive mode)
2. `SandboxPolicy.disclaimShell?: boolean` — DEFAULT false. When true, `LocalSandbox.run()` and `DockerSandbox.buildArgv()` swap the legacy `bash -lc <command>` tail for `disclaimedShellArgv("bash", command)`. Absent / false ⇒ byte-identical to the pre-feature codebase.
3. The disclaim is OPT-IN (not the default) because some workflows legitimately rely on a user-controlled `~/.bashrc` (custom PATH, language version managers). The CLI / web surface flips the bit when the operator wants the stricter posture.

## Consequences

**Positive**
- A hijacked user dotfile cannot inject into agent shell calls when `disclaimShell:true`.
- Pure shell-flag mechanism — no native code, no platform-specific spawn API.
- Cross-shell coverage (bash + zsh + sh) so a non-bash default shell still gets the protection.

**Trade-offs**
- This is NOT process-level entitlement isolation. macOS POSIX_SPAWN_SETDISCLAIM also prevents the child from inheriting Mach ports and file descriptors classified by the kernel — those guarantees do not transfer. Documented in the module header.
- `fish` and `pwsh` are not covered. Those shells require different flags; adding them is a one-line extension when a workflow needs them.

## Negative invariants

- `disclaimShell` unset MUST yield the exact argv used today (`bash -lc <command>`). Asserted by `tests/unit/shell-disclaim.test.ts`.
- A `disclaimShell:true` argv MUST NOT contain `-lc`. Asserted by the same test.

## Files touched

- `src/runtime/shell-disclaim.ts` — NEW.
- `src/runtime/sandbox.ts` — `SandboxPolicy.disclaimShell?`, LocalSandbox/DockerSandbox argv swap.
- `tests/unit/shell-disclaim.test.ts` — NEW (12 cases incl. DockerSandbox.buildArgv tail).
