/**
 * jun-11 — top-level `--version` / `-v` short-circuit (R3-hardened worklist #7).
 *
 * Before: `quanta --version` dropped through to an empty-prompt interactive REPL
 * (argvPrompt drops every dash token, so it never became a prompt — just a
 * confusing no-op that started the REPL). Now it prints the resolved build,
 * reusing the SAME `renderVersion()` the `/version` slash + welcome banner use
 * (no new version-string wiring), and exits 0 — the universal CLI convention.
 *
 * Subprocess e2e (mirrors session-cli-subprocess harness): `stdin: "ignore"` so
 * any pre-fix REPL fall-through sees EOF and cannot hang; isolated cwd so the
 * repo `.env.dev` is not autoloaded; dummy ANTHROPIC_API_KEY so provider
 * construction never throws on the (pre-fix) path that reaches it.
 *
 * RED before the index.ts short-circuit (no `quanta <semver>` line on stdout);
 * GREEN after.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI_ENTRY = new URL("../../src/apps/cli/index.ts", import.meta.url).pathname
const TIMEOUT_MS = 20000

const runCli = async (args: string[]): Promise<{ exit: number; out: string }> => {
  const cwd = mkdtempSync(join(tmpdir(), "cli-version-"))
  const proc = Bun.spawn({
    cmd: ["bun", CLI_ENTRY, ...args],
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      QUANTA_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { exit, out }
}

describe("top-level --version / -v flag (jun-11 #7)", () => {
  test(
    "--version prints `quanta <semver>` to stdout and exits 0",
    async () => {
      const r = await runCli(["--version"])
      expect(r.exit).toBe(0)
      expect(r.out).toMatch(/^quanta \d+\.\d+\.\d+/m)
    },
    TIMEOUT_MS,
  )

  test(
    "-v is an alias for --version",
    async () => {
      const r = await runCli(["-v"])
      expect(r.exit).toBe(0)
      expect(r.out).toMatch(/^quanta \d+\.\d+\.\d+/m)
    },
    TIMEOUT_MS,
  )
})
