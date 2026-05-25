/**
 * ADR-0204 — deterministic stub for tests.
 *
 * Never spawns a real shell; returns a fixed payload so unit suites do
 * not depend on the host having zsh / bash installed AND do not race on
 * timeouts. Production callers must NOT wire this — it exists for
 * tests only.
 */

import type { SnapshotSpawner } from "./zsh-capture"

/** Returns a stub-shell stdout body that is byte-identical across runs
 *  (no timestamps, no pids, no `Date.now()`). The body is non-empty so
 *  it passes the `empty-capture` guard. */
export const headlessStubBody = (shell: "zsh" | "bash"): string =>
  [
    `# headless-stub for ${shell}`,
    "typeset -gx LANG=en_US.UTF-8",
    "typeset -gx TZ=UTC",
    "alias ll='ls -la'",
    "alias gs='git status'",
    'g() { git "$@"; }',
    "",
  ].join("\n")

/** Deterministic spawner that always reports success. */
export const headlessSpawner: SnapshotSpawner = {
  async run(argv) {
    const shell = argv[0] === "zsh" ? "zsh" : "bash"
    return Promise.resolve({
      code: 0,
      stdout: headlessStubBody(shell),
      timedOut: false,
    })
  },
}
