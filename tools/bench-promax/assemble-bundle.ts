/**
 * PMX-00 operator tool — offline `assemble` of a frozen ProMax bundle.
 *
 * It is the step between FETCH and VERIFY. The fetch writes an upstream tree
 * (`gh/{swe-bench-promax.json,eval.json,test_run.py}` + `hf/{…}`); the validator
 * reads a bundle (`manifest.json`, `dataset.json`, `eval.json`, `evaluator.py`,
 * `hf/…`). Bridging the two by hand was the one place a wrong file could enter a
 * directory that then reports VERIFIED — so this tool does it, and REFUSES
 * rather than guessing.
 *
 * Like `verify-bundle.ts` it is a THIN shell over the one owner: it hashes
 * nothing, parses no manifest, and knows no file names. All of that lives in
 * `@/apps/bench/promax/provenance` (`planProMaxBundleAssembly`). This file only
 * performs the effects the pure planner cannot: read, list, mkdir, write.
 *
 * It is an OFFLINE PROVENANCE TOOL, not a fetcher: it never downloads anything
 * and never searches for a tree — both roots are explicit, matching
 * `requireExplicitBundleRoot`'s posture.
 *
 * Usage:
 *   bun run tools/bench-promax/assemble-bundle.ts \
 *     --upstream-root <fetched dir> \
 *     --bundle-root <FRESH output dir> \
 *     [--manifest <manifest.json>]
 *
 * `--manifest` defaults to the in-repo v1 manifest. `--bundle-root` must be
 * empty or absent: assembling over an existing bundle is refused, never merged.
 *
 * The full operator chain is documented in `tools/bench-promax/README.md`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  type ProMaxAssemblyPorts,
  planProMaxBundleAssembly,
  requireExplicitBundleRoot,
  requireExplicitUpstreamRoot,
} from "@/apps/bench/promax/provenance"

/**
 * The manifest that ships in git. This is a fixed build constant, NOT a search
 * path — `requireExplicitUpstreamRoot` refuses defaults for the things that
 * come from outside the tree; the manifest comes from inside it.
 */
export const DEFAULT_MANIFEST_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "apps",
  "bench",
  "promax",
  "provenance",
  "manifests",
  "promax-v1-170.manifest.json",
)

export interface AssembleArgs {
  readonly upstreamRoot: string
  readonly bundleRoot: string
  readonly manifestPath: string
}

export interface AssembleResult {
  readonly exitCode: number
  readonly output: string
}

/** Filesystem ports for the pure planner. Read-only; nothing is created here. */
const makePorts = (args: AssembleArgs): ProMaxAssemblyPorts => ({
  readSource: (relPath) => {
    const abs = join(args.upstreamRoot, relPath)
    return existsSync(abs) ? new Uint8Array(readFileSync(abs)) : undefined
  },
  listDestination: () =>
    existsSync(args.bundleRoot)
      ? readdirSync(args.bundleRoot, { recursive: true }).map((e) => String(e))
      : [],
})

/**
 * Assemble a bundle. Writes NOTHING unless every source file was present and
 * every one of them hashed to the value the manifest declares.
 */
export const assembleProMaxBundleDir = (args: AssembleArgs): AssembleResult => {
  const upstreamRoot = requireExplicitUpstreamRoot(args.upstreamRoot)
  const bundleRoot = requireExplicitBundleRoot(args.bundleRoot)
  const resolved: AssembleArgs = { upstreamRoot, bundleRoot, manifestPath: args.manifestPath }

  const plan = planProMaxBundleAssembly({
    manifestBytes: new Uint8Array(readFileSync(args.manifestPath)),
    manifestLabel: args.manifestPath,
    ports: makePorts(resolved),
  })
  if (!plan.ok) {
    return {
      exitCode: 1,
      output: [
        `REFUSED — the bundle was NOT assembled (${plan.failures.length} failure(s)):`,
        ...plan.failures.map((f) => `  [${f.code}] ${f.message}`),
      ].join("\n"),
    }
  }

  for (const file of plan.files) {
    const abs = join(bundleRoot, file.destRel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, file.bytes)
  }

  return {
    exitCode: 0,
    output: [
      "ASSEMBLED",
      `  bundle root          ${bundleRoot}`,
      `  upstream root        ${upstreamRoot}`,
      ...plan.files.map(
        (f) => `  ${f.destRel.padEnd(20)} ${f.sha256}  <- ${f.source} (${f.declaredBy})`,
      ),
      "  next",
      `    bun run tools/bench-promax/verify-bundle.ts --bundle-root ${bundleRoot} \\`,
      `      --head-commit ${plan.manifest.upstream_git_commit}`,
    ].join("\n"),
  }
}

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export const runAssembleCli = (argv: readonly string[]): AssembleResult =>
  assembleProMaxBundleDir({
    upstreamRoot: requireExplicitUpstreamRoot(flag(argv, "--upstream-root")),
    bundleRoot: requireExplicitBundleRoot(flag(argv, "--bundle-root")),
    manifestPath: flag(argv, "--manifest") ?? DEFAULT_MANIFEST_PATH,
  })

if (import.meta.main) {
  try {
    const { exitCode, output } = runAssembleCli(process.argv.slice(2))
    process.stdout.write(`${output}\n`)
    process.exit(exitCode)
  } catch (err) {
    process.stderr.write(`promax assemble: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
}
