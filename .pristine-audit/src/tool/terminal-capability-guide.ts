/**
 * Terminal-operator CAPABILITY GUIDANCE (RFC jun-29 §4.5 / §13 lever #5). A general
 * "how to drive a terminal well" prompt section — NOT a preset, NOT task-specific, and
 * deliberately free of any benchmark/gold-answer hint (it steers HOW to operate, never
 * WHAT the answer is). WIRED (jul-01): `src/apps/terminal` (`assembleTerminalSurface`) injects
 * this alongside the surface tools and the brain (`brain-mode.ts`) puts it in the model's system
 * turn (proven by the brain-mode hellgate, which asserts the full body reaches the model).
 *
 * Why it exists: the #1 real-world terminal-agent failure is "executable not in PATH"
 * (~24% of failures per the TB2.0 paper) — a pure environment-state problem the base loop
 * gives no guidance on. This encodes the SOTA habits that close it: probe before assuming,
 * exit-code = completion, install-on-demand, structured-exec over keystroke-typing.
 *
 * NB (jul-01): a measure-to-gate / verify-before-submit / no-overfit steer was tried here and
 * REVERTED — on the TB 3-task probe it produced zero solve-flips and made the agent over-persist
 * (an unsolvable task ran ~3× longer for no gain). Net-negative at n=1; not shipped. See
 * docs/analysis — the terminal bench analysis dir's FAILURE-RCA.md.
 */

/** The capability section text. General terminal-operator habits only. */
export const TERMINAL_OPERATOR_GUIDE = `You are operating a live terminal inside a container.

- Use \`container_exec\` for non-interactive steps: it runs one command and returns stdout, stderr, and the EXIT CODE — the exit code is your completion signal (0 = success), so you never have to guess whether a command finished. Use the \`pty_*\` tools only for genuinely interactive programs (an editor, a REPL, a TUI, a prompt that reads keystrokes).
- Do NOT assume a binary, interpreter, or tool is installed. Before relying on one, probe it (\`command -v <tool>\` / \`<tool> --version\`). The most common failure is "command not found" — an environment-state problem, not a logic one.
- When something is missing, discover the environment and install on demand: detect the package manager that is actually present (apt-get / dnf / apk / pip / npm / cargo / …) and use it, rather than assuming one. Re-probe after installing.
- Do not assume the working directory, PATH, or environment variables — check them when they matter.
- Prefer non-interactive invocations (pass flags that avoid prompts) so a step completes with a clean exit code instead of blocking on input.
- A command that may hang (a server, a watcher, something waiting on input) should get a \`timeout_ms\` so a wedged step returns with partial output instead of stalling you. A command that legitimately runs long (a big build, training) should NOT be given a tight timeout — run it in the background (\`nohup cmd > /tmp/build.log 2>&1 &\`) and poll the log/exit status instead.
- Verify before declaring done: re-run a check, inspect the exit code, or read the artifact you just produced. A zero exit on the verifying command is the proof, not your expectation.`

/** Accessor (function form mirrors the surface builders — the entry-point WILL call this when it
 *  assembles the terminal surface, the same place it calls `buildTerminalTools`; not yet wired). */
export const terminalOperatorGuide = (): string => TERMINAL_OPERATOR_GUIDE

/**
 * S1 self-test discipline (RFC jul-3, `QUANTA_TB_SELF_TEST`, default-OFF). An OPTIONAL addendum to the
 * operator guide, injected on the instruction turn ONLY when the knob is ON — default-OFF ⇒ byte-identical.
 *
 * Distinct from the jul-01 "verify-before-submit / measure-to-gate" steer that was REVERTED (net-negative
 * at n=1: zero solve-flips + over-persist). That steer nagged the agent to re-check a finished run; THIS
 * one targets the measured synthesis-convergence bottleneck (polyglot self-compared fib(0) only → passed a
 * wrong general solution; sam never ran its script). It asks the agent to build an EXECUTABLE self-test
 * FROM THE SPEC that covers the input RANGE + edges and iterate the DELIVERABLE to green — a coverage
 * discipline, not a re-check nag. Scoped to program/behavior deliverables and explicitly BOUNDED so it does
 * not reproduce the reverted steer's over-persist. No-leak: built from the task spec only, never the hidden
 * test/verifier/answer files. Efficacy is measure-first (A/B on the box); if it does not lift, the knob is
 * removed. See docs/plans/jul-3-tb-lever-audit-fixes/02-bestofn-audit-and-sota.md (S1). */
export const SELF_TEST_DISCIPLINE = `# Self-test before finalizing (for a program / script / function with a defined input→output behavior)

- Construct your OWN executable self-test FROM THE TASK SPEC: pick concrete inputs that cover the behavior across its RANGE and edges — several successive values, plus boundary/zero/empty cases — not a single example. Compute each expected output from the spec, then run YOUR deliverable against them.
- A single value passing is NOT proof: a wrong general solution can still match one input. Cover the range so the self-test would catch an off-by-one, a wrong recurrence, or a case you special-cased.
- If any case mismatches, fix the deliverable and re-run your self-test until EVERY case passes.
- Build this self-test only from the task's own description. Do NOT read, import, or run any provided test/verifier/answer files — that is the hidden grader, not yours.
- This is BOUNDED: once your self-test covers the range and every case passes, finalize. Do not keep expanding the test or reworking a solution that already passes.`
