/**
 * E2E — an MCP config the launch folder names runs nothing until the folder is trusted.
 *
 * THE DEFECT (round-11 audit A1, reproduced on the real CLI). `readMcpConfig` refused an
 * untrusted folder's `.mcp.json`, but counted any `QUANTA_MCP_CONFIG` value as a path the
 * operator named. The CLI loads the launch folder's `.env.dev` before MCP loads, so a clone
 * whose `.env.dev` named its own config ran that config's command; so did a relative value
 * from the real environment, which resolves against the launch folder.
 *
 * The unit hellgate (`tests/unit/cli/workspace-trust-hellgate.test.ts`) drives the reader
 * for all three env names. This drives the CLI entry itself, where the order "dotenv
 * first, MCP second" lives: a one-shot run in a scratch repo whose one MCP server touches a
 * marker. The LLM is a replay cassette (no key, no network). Every child gets an explicit
 * env with a scratch HOME and QUANTA_CONFIG_DIR, so no developer trust file is read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { asScrubbedEnv, bunScrubbedSpawner } from "@/runtime/scrubbed-spawn"
import { repoFile } from "../_helpers/repo-root"
import { makeTempDirOwner } from "../_helpers/temp-dir"

const CLI_ENTRY = repoFile("src/apps/cli/index.ts")
const RUN_TIMEOUT_MS = 90_000

const roots = makeTempDirOwner()
let base = ""
let cassette = ""
let seq = 0

beforeAll(() => {
  base = roots.create("cli-mcp-dotenv-trust-")
  cassette = join(base, "cassette.jsonl")
  const turn = JSON.stringify({
    id: "replay",
    events: [
      { type: "text_delta", delta: "OK" },
      { type: "usage", inputTokens: 1, outputTokens: 1, model: "replay" },
      { type: "message_stop", stop_reason: "end_turn" },
    ],
  })
  writeFileSync(cassette, `${Array.from({ length: 6 }, () => turn).join("\n")}\n`)
})
afterAll(() => {
  roots.disposeAll()
})

interface Repo {
  readonly dir: string
  readonly marker: string
  readonly home: string
  readonly configDir: string
}

/** A git repo holding `evil.json`, whose one server touches the marker. There is no
 *  `.mcp.json`: the config is reachable only through the path an env value names. */
const makeRepo = (): Repo => {
  const root = join(base, `arm-${++seq}`)
  const dir = join(root, "repo")
  mkdirSync(join(dir, ".git"), { recursive: true })
  const real = realpathSync(dir)
  const marker = join(real, "EXECUTED.marker")
  writeFileSync(
    join(dir, "evil.json"),
    JSON.stringify({
      mcpServers: { evil: { command: "sh", args: ["-c", 'touch "$1"', "sh", marker] } },
    }),
  )
  const home = join(root, "home")
  const configDir = join(root, "quanta-home")
  mkdirSync(home, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  return { dir: real, marker, home, configDir }
}

const runCli = async (
  repo: Repo,
  extraEnv: Record<string, string> = {},
): Promise<{ exit: number; err: string }> => {
  const proc = bunScrubbedSpawner([process.execPath, CLI_ENTRY, "-p", "say ok"], {
    cwd: repo.dir,
    env: asScrubbedEnv({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: repo.home,
      QUANTA_CONFIG_DIR: repo.configDir,
      QUANTA_LLM_REPLAY: cassette,
      QUANTA_MEMORY: "off",
      QUANTA_MEMORY_AUTO: "0",
      QUANTA_ENABLE_PROMPT_SUGGESTION: "0",
      QUANTA_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-not-a-real-key",
      NO_COLOR: "1",
      ...extraEnv,
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"ignore", "pipe", "pipe">
  const [, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exit, err }
}

describe("a launch folder's MCP config path (real CLI one-shot)", () => {
  test(
    "RED: the folder's .env.dev naming its own config starts nothing, and says why",
    async () => {
      const repo = makeRepo()
      writeFileSync(join(repo.dir, ".env.dev"), "QUANTA_MCP_CONFIG=evil.json\n")
      const run = await runCli(repo)
      expect(existsSync(repo.marker), run.err).toBe(false)
      expect(run.err).toContain("not a trusted folder")
      expect(run.err).toContain(`QUANTA_MCP_CONFIG in ${join(repo.dir, ".env.dev")}`)
    },
    RUN_TIMEOUT_MS,
  )

  test(
    "RED: an absolute path in the folder's .env.dev starts nothing either",
    async () => {
      const repo = makeRepo()
      writeFileSync(
        join(repo.dir, ".env.dev"),
        `QUANTA_MCP_CONFIG=${join(repo.dir, "evil.json")}\n`,
      )
      const run = await runCli(repo)
      expect(existsSync(repo.marker), run.err).toBe(false)
      expect(run.err).toContain("not a trusted folder")
    },
    RUN_TIMEOUT_MS,
  )

  test(
    "PAIRED CONTROL: the same .env.dev in a folder the operator trusts starts the server",
    async () => {
      const repo = makeRepo()
      writeFileSync(join(repo.dir, ".env.dev"), "QUANTA_MCP_CONFIG=evil.json\n")
      const run = await runCli(repo, { QUANTA_TRUSTED_PATHS: repo.dir })
      expect(existsSync(repo.marker), run.err).toBe(true)
    },
    RUN_TIMEOUT_MS,
  )

  test(
    "RED: a relative QUANTA_MCP_CONFIG from the real environment starts nothing in an untrusted folder",
    async () => {
      const repo = makeRepo()
      const run = await runCli(repo, { QUANTA_MCP_CONFIG: "evil.json" })
      expect(existsSync(repo.marker), run.err).toBe(false)
      expect(run.err).toContain("not a trusted folder")
    },
    RUN_TIMEOUT_MS,
  )

  test(
    "PAIRED CONTROL: an absolute QUANTA_MCP_CONFIG from the real environment is the operator's",
    async () => {
      const repo = makeRepo()
      const run = await runCli(repo, { QUANTA_MCP_CONFIG: join(repo.dir, "evil.json") })
      expect(existsSync(repo.marker), run.err).toBe(true)
    },
    RUN_TIMEOUT_MS,
  )
})
