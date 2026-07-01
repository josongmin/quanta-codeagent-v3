/**
 * Terminal-operator CAPABILITY GUIDANCE (RFC jun-29 §4.5 / §13 lever #5). A general
 * "how to drive a terminal well" prompt section — NOT a preset, NOT task-specific, and
 * deliberately free of any benchmark/gold-answer hint (it steers HOW to operate, never
 * WHAT the answer is). The composition root that assembles the `terminal` surface
 * (`buildTerminalTools`) WILL inject this as a capability section (NOT yet wired); it is a pure
 * string artifact with no wiring of its own, so it stays inert until that entry-point lands.
 *
 * Why it exists: the #1 real-world terminal-agent failure is "executable not in PATH"
 * (~24% of failures per the TB2.0 paper) — a pure environment-state problem the base loop
 * gives no guidance on. This encodes the SOTA habits that close it: probe before assuming,
 * exit-code = completion, install-on-demand, structured-exec over keystroke-typing.
 *
 * STATUS: content artifact only — NOT yet wired. `buildTerminalTools` returns tools, not this
 * string; the terminal entry-point (P2, box phase) WILL inject it as a capability section when it
 * assembles the surface. Until then it is inert (no consumer). Do not read the lines below as
 * "active behavior" — they describe the INTENDED injection point, not a wired one.
 */

/** The capability section text. General terminal-operator habits only. */
export const TERMINAL_OPERATOR_GUIDE = `You are operating a live terminal inside a container.

- Use \`container_exec\` for non-interactive steps: it runs one command and returns stdout, stderr, and the EXIT CODE — the exit code is your completion signal (0 = success), so you never have to guess whether a command finished. Use the \`pty_*\` tools only for genuinely interactive programs (an editor, a REPL, a TUI, a prompt that reads keystrokes).
- Do NOT assume a binary, interpreter, or tool is installed. Before relying on one, probe it (\`command -v <tool>\` / \`<tool> --version\`). The most common failure is "command not found" — an environment-state problem, not a logic one.
- When something is missing, discover the environment and install on demand: detect the package manager that is actually present (apt-get / dnf / apk / pip / npm / cargo / …) and use it, rather than assuming one. Re-probe after installing.
- Do not assume the working directory, PATH, or environment variables — check them when they matter.
- Prefer non-interactive invocations (pass flags that avoid prompts) so a step completes with a clean exit code instead of blocking on input.
- Verify before declaring done: re-run a check, inspect the exit code, or read the artifact you just produced. A zero exit on the verifying command is the proof, not your expectation.`

/** Accessor (function form mirrors the surface builders — the entry-point WILL call this when it
 *  assembles the terminal surface, the same place it calls `buildTerminalTools`; not yet wired). */
export const terminalOperatorGuide = (): string => TERMINAL_OPERATOR_GUIDE
