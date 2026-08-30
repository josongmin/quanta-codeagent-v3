import { readFileSync, rmSync, writeFileSync } from "node:fs"
import {
  assertShardCoverage,
  parseShardDiscovery,
  type ShardDiscovery,
} from "./test-shard-coverage"

/**
 * Authoritative local full-suite runner.
 *
 * Bun's one-process full run exhausts JSC on this repository. The worker
 * script remains available as `test:shard`, but this runner owns the full
 * verdict: it runs every one of Bun's eight deterministic file shards
 * SEQUENTIALLY, records every exit, and refuses to bless a result if another
 * session changed the checkout while it was running.
 */

const SHARD_COUNT = 8
// The shard corpus contains cold-path source scans and real CLI integration
// rails. A normal shard has exceeded seven minutes without any failed test, so
// five minutes turns ordinary host variance into a false timeout. Twelve
// minutes still bounds a CPU-bound Bun worker that ignores Bun's per-test
// timeout while leaving headroom for the measured cold path.
const SHARD_TIMEOUT_MS = 12 * 60_000
const SUITE_ROOTS = {
  full: [
    "tests/unit",
    "tests/meta",
    "tests/adversarial",
    "tests/measurement",
    "tests/integration",
    "./src/",
    "./tools/",
  ],
  core: [
    "tests/unit",
    "tests/meta",
    "tests/adversarial",
    "tests/measurement",
    "./src/",
    "./tools/",
  ],
  unit: ["tests/unit"],
  integration: ["tests/integration"],
} as const

type SuiteName = keyof typeof SUITE_ROOTS

interface RunnerOptions {
  readonly suite: SuiteName
  readonly junitOut?: string
}

interface GitSnapshot {
  readonly head: string
  readonly status: string
}

const capture = async (
  cmd: readonly string[],
): Promise<{ readonly code: number; readonly text: string }> => {
  const proc = Bun.spawn({ cmd: [...cmd], stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, text: `${stdout}${stderr}` }
}

const gitSnapshot = async (): Promise<GitSnapshot> => {
  const [head, status] = await Promise.all([
    capture(["git", "rev-parse", "HEAD"]),
    capture(["git", "status", "--porcelain"]),
  ])
  if (head.code !== 0 || status.code !== 0) {
    throw new Error(`test shards require a readable Git checkout: ${head.text}${status.text}`)
  }
  return { head: head.text.trim(), status: status.text }
}

const sameSnapshot = (left: GitSnapshot, right: GitSnapshot): boolean =>
  left.head === right.head && left.status === right.status

const suiteOption = (arg: string): SuiteName | undefined => {
  if (!arg.startsWith("--suite=")) return undefined
  const candidate = arg.slice("--suite=".length)
  if (!(candidate in SUITE_ROOTS)) throw new Error(`unknown shard suite: ${candidate}`)
  return candidate as SuiteName
}

const junitOption = (arg: string): string | undefined => {
  if (!arg.startsWith("--junit-out=")) return undefined
  const candidate = arg.slice("--junit-out=".length)
  if (!candidate.startsWith(".cache/") || candidate.includes("..")) {
    throw new Error("--junit-out must be a safe .cache/ path")
  }
  return candidate
}

const parseOptions = (args: readonly string[]): RunnerOptions => {
  let suite: SuiteName = "full"
  let junitOut: string | undefined
  for (const arg of args) {
    if (arg === "--parallel=1") continue
    const selectedSuite = suiteOption(arg)
    if (selectedSuite !== undefined) {
      suite = selectedSuite
      continue
    }
    const selectedJunit = junitOption(arg)
    if (selectedJunit !== undefined) {
      junitOut = selectedJunit
      continue
    }
    throw new Error(`unknown shard runner argument: ${arg}`)
  }
  if (junitOut !== undefined && suite !== "unit") {
    throw new Error("JUnit shard receipts are reserved for --suite=unit")
  }
  return junitOut === undefined ? { suite } : { suite, junitOut }
}

const junitShardPath = (junitOut: string, index: number): string => `${junitOut}.shard-${index}.xml`

const prepareJunit = (junitOut: string): void => {
  rmSync(junitOut, { force: true })
  for (let index = 1; index <= SHARD_COUNT; index += 1) {
    rmSync(junitShardPath(junitOut, index), { force: true })
  }
}

const mergeJunit = (junitOut: string): void => {
  const bodies: string[] = []
  for (let index = 1; index <= SHARD_COUNT; index += 1) {
    const xml = readFileSync(junitShardPath(junitOut, index), "utf8")
    const root = xml.indexOf("<testsuites")
    const open = root < 0 ? -1 : xml.indexOf(">", root)
    const close = xml.lastIndexOf("</testsuites>")
    if (root < 0 || open < 0 || close < 0 || !xml.includes("<testcase")) {
      throw new Error(`[test:shards] invalid JUnit receipt from shard ${index}/${SHARD_COUNT}`)
    }
    bodies.push(xml.slice(open + 1, close).trim())
  }
  writeFileSync(
    junitOut,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test sharded">\n${bodies.join("\n")}\n</testsuites>\n`,
  )
}

const relay = async (
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void,
  observe: (text: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    observe(text)
    write(text)
  }
  const tail = decoder.decode()
  if (tail !== "") {
    observe(tail)
    write(tail)
  }
}

const runShard = async (
  index: number,
  opts: RunnerOptions,
): Promise<{
  readonly code: number
  readonly timedOut: boolean
  readonly discovery?: ShardDiscovery
}> => {
  const shard = `${index}/${SHARD_COUNT}`
  const junitArgs =
    opts.junitOut === undefined
      ? []
      : ["--reporter=junit", `--reporter-outfile=${junitShardPath(opts.junitOut, index)}`]
  process.stdout.write(`\n[test:shards] START shard=${shard}\n`)
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "test",
      ...SUITE_ROOTS[opts.suite],
      "--timeout=60000",
      "--parallel=1",
      `--shard=${shard}`,
      ...junitArgs,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  let banner = ""
  let discovery: ShardDiscovery | undefined
  const observe = (text: string): void => {
    if (discovery !== undefined) return
    banner = `${banner}${text}`.slice(-512)
    discovery = parseShardDiscovery(banner, shard)
  }
  const stdout = relay(proc.stdout, (text) => process.stdout.write(text), observe)
  const stderr = relay(proc.stderr, (text) => process.stderr.write(text), observe)
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    process.stderr.write(
      `[test:shards] TIMEOUT shard=${shard} after=${SHARD_TIMEOUT_MS}ms; killing worker\n`,
    )
    proc.kill(9)
  }, SHARD_TIMEOUT_MS)
  const code = await proc.exited
  clearTimeout(timeout)
  await Promise.all([stdout, stderr])
  process.stdout.write(
    `[test:shards] END shard=${shard} exit=${code}${timedOut ? " timeout" : ""}\n`,
  )
  return discovery === undefined ? { code, timedOut } : { code, timedOut, discovery }
}

const main = async (): Promise<void> => {
  const opts = parseOptions(process.argv.slice(2))
  const before = await gitSnapshot()
  if (before.status !== "") {
    throw new Error(
      "[test:shards] INVALID — authoritative receipts require a clean checkout. Commit or stash changes first.",
    )
  }
  if (opts.junitOut !== undefined) prepareJunit(opts.junitOut)
  process.stdout.write(`[test:shards] frozen head=${before.head} suite=${opts.suite} dirty=no\n`)

  const failed: number[] = []
  const discoveries: ShardDiscovery[] = []
  for (let index = 1; index <= SHARD_COUNT; index += 1) {
    const result = await runShard(index, opts)
    if (result.code !== 0 || result.timedOut) failed.push(index)
    if (result.discovery !== undefined) discoveries.push(result.discovery)
  }

  const after = await gitSnapshot()
  if (!sameSnapshot(before, after)) {
    throw new Error(
      `[test:shards] INVALID — checkout changed during run (start=${before.head}, end=${after.head}). ` +
        "Re-run against one stable snapshot; this receipt cannot describe a single source state.",
    )
  }
  if (failed.length > 0) {
    throw new Error(`[test:shards] FAILED shard(s): ${failed.join(", ")}/${SHARD_COUNT}`)
  }
  assertShardCoverage(discoveries, SHARD_COUNT)
  if (opts.junitOut !== undefined) mergeJunit(opts.junitOut)
  process.stdout.write(
    `[test:shards] PASS suite=${opts.suite} shards=1-${SHARD_COUNT}/${SHARD_COUNT} head=${before.head}\n`,
  )
}

await main()
