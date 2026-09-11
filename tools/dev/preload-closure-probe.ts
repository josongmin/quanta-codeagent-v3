/**
 * PRELOAD RUNTIME-CLOSURE PROBE (TVH-11) — the `meta-runtime` producer.
 *
 * WHY A REAL CHILD PROCESS IS THE RIGHT ANSWER HERE, AND WHY IT MOVED.
 *
 * `tests/meta/preload-runtime-closure-hellgate.test.ts` guards a property of
 * the RUNTIME: how many `src/` modules bun actually resides after
 * `bunfig.toml`'s preload runs. A static import walk cannot answer it — the
 * previous attempt produced 2,301 because it counted comments and type-only
 * edges. So the gate must observe a real bun process under the real bunfig.
 *
 * What was wrong was not the child process, it was WHERE it ran: the probe sat
 * inside the `describe` callback of an ordinary meta test file, and `describe`
 * callbacks execute at MODULE LOAD. Merely importing that file started a nested
 * `bun test`, wrote a probe directory inside the repo, and — in a second test —
 * started another `bun run`. Discovery paid for both.
 *
 * This module is that work, extracted: ONE invocation, TWO probes, ONE small
 * JSON artifact. The test consumes the artifact. A runner that wants the cost
 * accounted to a `meta-runtime` resource class can produce it up front (see
 * `docs/plans/sep-12-test-verification-hardening/handoff-tvh11.md`); absent
 * that, the test produces it once in `beforeAll`, which is still strictly
 * better than at import.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const PRELOAD_CLOSURE_ARTIFACT_SCHEMA = "quanta.preload-closure-artifact.v1" as const
export const PRELOAD_CLOSURE_ARTIFACT_ENV = "QUANTA_PRELOAD_CLOSURE_ARTIFACT"

export interface PreloadClosureArtifact {
  readonly schema: typeof PRELOAD_CLOSURE_ARTIFACT_SCHEMA
  readonly producedAtMs: number
  /** Repo-relative `src/` modules resident in a preloaded child, sorted. */
  readonly loadedSrcModules: readonly string[]
  /** The branch-search override cell's set→clear round trip, driven for real. */
  readonly overrideRoundTrip: { readonly ok: boolean; readonly output: string }
}

/**
 * Staged under the repo's ignored `tests/.tmp/`, NOT a system temp directory:
 * the probe must be preloaded exactly like any other test file, and a probe
 * outside the tree would not pick up `bunfig.toml` at all — it would report a
 * clean closure for the wrong reason. A visible transient `tests/zz-*` made a
 * concurrent authoritative shard observe a dirty checkout, hence `.tmp`.
 */
const makeProbeDir = (repoRoot: string, prefix: string): string => {
  const probeRoot = join(repoRoot, "tests", ".tmp")
  mkdirSync(probeRoot, { recursive: true })
  return mkdtempSync(join(probeRoot, prefix))
}

const MODULE_PROBE = [
  `import { test } from "bun:test"`,
  `test("report the runtime module set", () => {`,
  `  const loaded = Object.keys(require.cache ?? {})`,
  `  process.stdout.write("MODULES:" + JSON.stringify(loaded) + "\\n")`,
  `})`,
  ``,
].join("\n")

const RESET_PROBE = `
  import { __setBranchRunAgentForTest, branchRunAgentOverride }
    from "@/agent/branch-search-runner/run-agent-override"
  const sentinel = (() => undefined) as never
  __setBranchRunAgentForTest(sentinel)
  if (branchRunAgentOverride() !== sentinel) throw new Error("set did not take")
  __setBranchRunAgentForTest(null)
  if (branchRunAgentOverride() !== null) throw new Error("reset did not clear")
  process.stdout.write("RESET-OK\\n")
`

const runInProbeDir = (
  repoRoot: string,
  prefix: string,
  fileName: string,
  source: string,
  argv: (file: string) => readonly string[],
): string => {
  const dir = makeProbeDir(repoRoot, prefix)
  try {
    const file = join(dir, fileName)
    writeFileSync(file, source)
    const proc = Bun.spawnSync([...argv(file)], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    })
    return `${proc.stdout.toString()}${proc.stderr.toString()}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const parseLoadedModules = (repoRoot: string, output: string): readonly string[] => {
  const line = /MODULES:(\[.*\])/.exec(output)
  if (line === null) return []
  return (JSON.parse(line[1] as string) as string[])
    .map((p) => (p.startsWith(repoRoot) ? p.slice(repoRoot.length + 1) : p))
    .filter((p) => p.startsWith("src/"))
    .sort()
}

/** Runs BOTH child probes. This is the only function here that spawns. */
export const producePreloadClosureArtifact = (repoRoot: string): PreloadClosureArtifact => {
  const moduleOutput = runInProbeDir(
    repoRoot,
    "preload-probe-",
    "probe.test.ts",
    MODULE_PROBE,
    (file) => ["bun", "test", file],
  )
  const resetOutput = runInProbeDir(repoRoot, "reset-probe-", "probe.ts", RESET_PROBE, (file) => [
    "bun",
    "run",
    file,
  ])
  return {
    schema: PRELOAD_CLOSURE_ARTIFACT_SCHEMA,
    producedAtMs: Date.now(),
    loadedSrcModules: parseLoadedModules(repoRoot, moduleOutput),
    overrideRoundTrip: { ok: resetOutput.includes("RESET-OK"), output: resetOutput.slice(-2_000) },
  }
}

export const writePreloadClosureArtifact = (
  path: string,
  artifact: PreloadClosureArtifact,
): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
}

/**
 * Read a pre-produced artifact, or produce one.
 *
 * A malformed or wrong-schema artifact is NOT silently replaced by a fresh
 * probe: that would make a broken producer indistinguishable from a healthy
 * one. It throws, and the caller sees which.
 */
export const loadOrProducePreloadClosureArtifact = (
  repoRoot: string,
  env: { readonly [key: string]: string | undefined } = process.env,
): PreloadClosureArtifact => {
  const path = env[PRELOAD_CLOSURE_ARTIFACT_ENV]
  if (path === undefined || path.trim().length === 0) return producePreloadClosureArtifact(repoRoot)
  if (!existsSync(path)) {
    throw new Error(`${PRELOAD_CLOSURE_ARTIFACT_ENV}=${path} does not exist`)
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PreloadClosureArtifact>
  if (parsed.schema !== PRELOAD_CLOSURE_ARTIFACT_SCHEMA) {
    throw new Error(`${path} is not a ${PRELOAD_CLOSURE_ARTIFACT_SCHEMA}`)
  }
  if (!Array.isArray(parsed.loadedSrcModules) || typeof parsed.overrideRoundTrip !== "object") {
    throw new Error(`${path} is a ${PRELOAD_CLOSURE_ARTIFACT_SCHEMA} with missing fields`)
  }
  return parsed as PreloadClosureArtifact
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const at = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const repoRoot = at("repo-root") ?? process.cwd()
  const out = at("out") ?? join(repoRoot, ".quanta-cache", "meta", "preload-closure.json")
  const artifact = producePreloadClosureArtifact(repoRoot)
  writePreloadClosureArtifact(out, artifact)
  process.stdout.write(
    `${out}\n  src modules: ${artifact.loadedSrcModules.length}\n  override round trip: ${artifact.overrideRoundTrip.ok}\n`,
  )
  process.stdout.write(`export ${PRELOAD_CLOSURE_ARTIFACT_ENV}=${out}\n`)
}
