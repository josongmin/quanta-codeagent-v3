import { describe, expect, test } from "bun:test"
import { withTempDir } from "../_helpers/temp-dir"

const CLI_ENTRY = new URL("../../src/apps/cli/index.ts", import.meta.url).pathname
const TIMEOUT_MS = 20_000

const runCli = async (args: readonly string[]): Promise<{ exit: number; err: string }> =>
  // The temp cwd was inlined into the `cwd:` field, so no binding existed that
  // any cleanup could name. `withTempDir` gives it an owner and a `finally`.
  withTempDir("cli-tool-profile-", async (cwd) => {
    const proc = Bun.spawn({
      cmd: ["bun", CLI_ENTRY, ...args],
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        QUANTA_PROVIDER: "anthropic",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [err, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    return { exit, err }
  })

describe("shipping CLI --tool-profile preflight", () => {
  test(
    "invalid value exits EX_USAGE before provider/LLM construction",
    async () => {
      const result = await runCli(["--tool-profile", "bogus", "fix x"])
      expect(result.exit).toBe(64)
      expect(result.err).toContain("--tool-profile must be one of")
      expect(result.err).not.toContain("API key")
    },
    TIMEOUT_MS,
  )

  test(
    "missing value exits EX_USAGE before provider/LLM construction",
    async () => {
      const result = await runCli(["--tool-profile"])
      expect(result.exit).toBe(64)
      expect(result.err).toContain("flag '--tool-profile' requires a value")
      expect(result.err).not.toContain("API key")
    },
    TIMEOUT_MS,
  )
})
