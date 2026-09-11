/**
 * Live subprocess hellgate — `quanta /<slash>` surface-command argv dispatch
 * exercised through `Bun.spawn` (NOT in-process).
 *
 * Why a subprocess test (and not just in-process `runSlashCommand` calls):
 *   - The in-process file (`debug-cli-surface-e2e-hellgate.test.ts`) covers
 *     the slash dispatch through a synthetic SlashContext. This file pins the
 *     ACTUAL CLI entry point (`src/apps/cli/index.ts`) — argv routing,
 *     `loadEnvFiles`, `isSlashCommand`, `runSlashMain` — by spawning the
 *     binary the user spawns. A regression in argv routing or env loading
 *     cannot be observed in the in-process test.
 *   - Validates the "default-OFF" contract end-to-end: with NO LLM key, NO
 *     active session, NO TTY, the 4 surface slashes (`/debug`, `/inspect`,
 *     `/replay`, `/why`) print their "not wired" lines + exit cleanly. A
 *     regression that lets one of them reach the agent loop / LLM client
 *     would HANG (no key) or CRASH (constructor throws) — surfaced here as
 *     a timeout or non-zero exit with diagnostic noise.
 *
 * Critical invariants exercised (one per case):
 *   - exit code is the documented value (0 or 1), not a generic 0.
 *   - stdout vs stderr split is the documented one (panels on stdout,
 *     errors/diagnostics on stderr).
 *   - `QUANTA_DEBUG=1` does NOT spuriously produce tracer output for
 *     surface-command short-circuits (the tracer wires at the agent loop
 *     boot — slash dispatch never enters that path).
 *   - timeout cap is 15 s per case to keep CI honest.
 *   - env is `env -i`-clean — only PATH + HOME + ANTHROPIC_API_KEY=test
 *     so a dev machine with real keys cannot accidentally exit cleanly via
 *     a path that's never expected to reach the LLM.
 *   - cwd is a tmpdir, so the repo's `.env.dev` is NOT autoloaded.
 *
 * No LLM call is made anywhere in this suite. Every surface command short-
 * circuits BEFORE the agent loop is constructed.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { bunEntryArgv } from "../_helpers/repo-root"
import { makeTempDirOwner } from "../_helpers/temp-dir"

/**
 * Every temp root this file makes, removed in `afterEach` whether the case
 * passed, failed, or threw. Before this, each `mkdtempSync` here had no `rm`
 * anywhere in the file and left one directory per case per run.
 */
const tempRoots = makeTempDirOwner()
afterEach(() => {
  tempRoots.disposeAll()
})

// Repository-RELATIVE entry. The absolute path is resolved at spawn time by
// walking up from this file to the repository marker
// (tests/_helpers/repo-root.ts) — a hard-coded checkout path makes
// `Bun.spawn(["bun", <missing path>, …])` exit non-zero with a message on
// stderr, and "non-zero exit with a message on stderr" is exactly what several
// cases below assert as a PASS.
const CLI_ENTRY = "src/apps/cli/index.ts"
/** Per-case timeout. Surface-slash dispatch should complete in <500ms in
 *  practice; the cap is loose so a heavily-loaded CI box doesn't flake. */
const TEST_TIMEOUT_MS = 15_000

interface RunResult {
  exit: number
  out: string
  err: string
}

interface RunOpts {
  /** Extra env to layer ON TOP of the minimal default. */
  env?: Record<string, string>
}

/**
 * Spawn the CLI binary as a subprocess. Defaults pin the run to a
 * deterministic env:
 *   - cwd  = fresh tmpdir, so `.env.dev` autoload finds nothing.
 *   - env  = MINIMAL — PATH + HOME + ANTHROPIC_API_KEY=test (so any
 *            unforeseen LLM construction path fails LOUDLY rather than
 *            hanging on a real key).
 *   - stdin "ignore" — surface commands consume zero stdin; if a future
 *            regression makes the binary block on stdin, the test times
 *            out cleanly.
 */
const runCli = async (args: string[], opts: RunOpts = {}): Promise<RunResult> => {
  const cwd = tempRoots.create("cli-live-debug-")
  // Layer the parent PATH/HOME ONLY — drop every other parent env var so
  // a developer's `ANTHROPIC_API_KEY=<real>` or `QUANTA_*` leak cannot
  // affect the outcome.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    // Dummy key so any defensive LLM-construction along the way doesn't
    // throw a "missing key" error BEFORE the surface command runs.
    ANTHROPIC_API_KEY: "test",
    // Pin provider so the binary doesn't try to silently use OPENAI from
    // a missing/stale env.
    QUANTA_PROVIDER: "anthropic",
    ...opts.env,
  }
  const proc = Bun.spawn({
    cmd: [...bunEntryArgv(CLI_ENTRY, args)],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exit, out, err }
}

/** Strip Node's "Debugger attached"/"Waiting for debugger" lines that some
 *  hosts inject; the binary never emits them itself. Also collapse trailing
 *  CR/LF so assertions don't depend on tty line-ending policy. */
const clean = (s: string): string =>
  s
    .split("\n")
    .filter((l) => !l.startsWith("Debugger attached") && !l.startsWith("Waiting for the debugger"))
    .join("\n")

describe("CLI live-subprocess — surface-slash dispatch", () => {
  test(
    "case-01: `/debug status` (no ctx.debug) → 'not wired' on stdout, exit 0, stderr empty",
    async () => {
      const r = await runCli(["/debug", "status"])
      expect(r.exit).toBe(0)
      // PINNED LINE — `slash-commands.ts#debugCmd.run` emits this exact text
      // when `ctx.debug === undefined`. The QUANTA_DEBUG hint is part of the
      // user-facing message; a regression that drops the hint must trip.
      expect(clean(r.out)).toBe(
        "/debug: not wired in this surface (boot with QUANTA_DEBUG=1 to enable runtime toggle)\n",
      )
      expect(clean(r.err)).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "case-02: `/inspect tc_anything` (no ctx.inspect) → 'no active session' on stdout, exit 1",
    async () => {
      const r = await runCli(["/inspect", "tc_anything"])
      expect(r.exit).toBe(1)
      // PINNED — `inspect-cmd.ts#runInspectCmd` emits this when sessionId is
      // undefined (the surface slash drives that branch).
      expect(clean(r.out)).toBe("no active session — start an agent first or pass --session <id>\n")
      expect(clean(r.err)).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "case-03: `/replay 01HXY` (no ctx.replay) → 'not wired' on stdout, exit 0",
    async () => {
      const r = await runCli(["/replay", "01HXY"])
      expect(r.exit).toBe(0)
      expect(clean(r.out)).toBe("/replay: not wired in this surface\n")
      expect(clean(r.err)).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "case-04: `/why last` (no ctx.why) → 'not wired' on stdout, exit 0; NO LLM call (no model name leak)",
    async () => {
      const r = await runCli(["/why", "last"])
      expect(r.exit).toBe(0)
      expect(clean(r.out)).toBe("/why: not wired in this surface\n")
      expect(clean(r.err)).toBe("")
      // NEGATIVE invariant — NO model identifier surfaces. A regression that
      // reached the LLM construction path would surface a model name or a
      // provider error here.
      expect(clean(r.out)).not.toMatch(/gpt-|claude-|sonnet|haiku|opus/i)
      expect(clean(r.err)).not.toMatch(/gpt-|claude-|sonnet|haiku|opus/i)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "case-05: `/debug bogus_category` from subprocess argv → default-OFF wins (ctx.debug absent → 'not wired')",
    async () => {
      // INVARIANT under audit: the slash adapter in `slash-commands.ts`
      // (`debugCmd.run`) checks `ctx.debug === undefined` BEFORE invoking
      // the handler. From the argv-dispatched surface (`runSlashMain`),
      // ctx.debug is never set. Therefore even a bad-arg invocation
      // surfaces the "not wired" message, NOT the leaf's bad-arg error.
      // (The leaf's bad-arg path is exercised by the in-process hellgate
      //  `debug-cli-surface-e2e-hellgate.test.ts` case-15.)
      const r = await runCli(["/debug", "bogus_category"])
      expect(r.exit).toBe(0)
      expect(clean(r.out)).toBe(
        "/debug: not wired in this surface (boot with QUANTA_DEBUG=1 to enable runtime toggle)\n",
      )
      expect(clean(r.err)).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "case-06: unknown slash `/no-such-cmd` → 'unknown command' on stderr + Available list on stdout + exit 1",
    async () => {
      const r = await runCli(["/no-such-cmd", "arg1"])
      expect(r.exit).toBe(1)
      // PINNED stderr message from `slash-engine.ts`.
      expect(clean(r.err)).toBe("slash: unknown command: /no-such-cmd\n")
      // Available list lands on stdout — first line is the literal header.
      const outLines = clean(r.out).split("\n")
      expect(outLines[0]).toBe("Available:")
      // At least the 4 surface-slice members appear in the available list.
      const outAll = clean(r.out)
      expect(outAll).toContain("/debug")
      expect(outAll).toContain("/inspect")
      expect(outAll).toContain("/replay")
      expect(outAll).toContain("/why")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "case-07: `QUANTA_DEBUG=1 /debug status` ⇒ slash dispatch produces ZERO tracer output (tracer wires at loop boot, NOT at surface short-circuit)",
    async () => {
      // INVARIANT under audit: `QUANTA_DEBUG=1` enables the agent-loop's
      // debug tracer wire (see `session-setup.ts#buildDebugTracerAndStream`).
      // The slash dispatch path (`runSlashMain`) NEVER constructs the loop,
      // so even with `QUANTA_DEBUG=1` set, no tracer output should land on
      // stderr. A regression that wires the tracer at process boot (rather
      // than at session-setup boot) would surface here as decoration noise
      // on stderr — instantly failing the equality check.
      const r = await runCli(["/debug", "status"], { env: { QUANTA_DEBUG: "1" } })
      expect(r.exit).toBe(0)
      expect(clean(r.out)).toBe(
        "/debug: not wired in this surface (boot with QUANTA_DEBUG=1 to enable runtime toggle)\n",
      )
      // Critical: stderr is EMPTY despite QUANTA_DEBUG=1. No `[t0]` line,
      // no `decision`, no `tool_call` — the tracer is dormant in the slash
      // path.
      expect(clean(r.err)).toBe("")
      // Defense-in-depth — verify the tracer's per-line format prefix is
      // absent (HH:MM:SS.mmm).
      expect(clean(r.err)).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "case-08: subprocess env hygiene — no parent env leak of ANTHROPIC_API_KEY into stdout/stderr",
    async () => {
      // PRIVACY invariant: the dummy `ANTHROPIC_API_KEY=test` we set in
      // the runCli env helper must NOT echo into the user-visible output
      // through any code path. A regression in env-debug logging would
      // expose keys in CI artefacts. This case pins the negative
      // invariant: regardless of QUANTA_DEBUG=1 + a real-looking key
      // value, the output is clean.
      const r = await runCli(["/debug", "status"], {
        env: { QUANTA_DEBUG: "1", ANTHROPIC_API_KEY: "sk-test-FAKE-NOT-A-REAL-KEY" },
      })
      expect(r.exit).toBe(0)
      // Key value MUST NOT appear in stdout or stderr — byte-level.
      expect(r.out).not.toContain("sk-test-FAKE-NOT-A-REAL-KEY")
      expect(r.err).not.toContain("sk-test-FAKE-NOT-A-REAL-KEY")
      // The token "ANTHROPIC_API_KEY" itself should also stay out of the
      // surface output (any future "boot diagnostic" that prints env names
      // is a regression candidate).
      expect(r.out).not.toContain("ANTHROPIC_API_KEY")
      expect(r.err).not.toContain("ANTHROPIC_API_KEY")
    },
    TEST_TIMEOUT_MS,
  )
})
