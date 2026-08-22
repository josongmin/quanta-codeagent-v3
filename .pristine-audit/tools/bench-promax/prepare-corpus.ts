/**
 * PMX-02 operator tool — TRUSTED PREPARATION of a ProMax campaign.
 *
 * It does three things, and DELEGATES all three:
 *
 *   1. verify the frozen bundle              → PMX-00 `verifyProMaxBundle`
 *   2. split it into the two artifacts       → PMX-02 `decodeProMaxOfficialCorpus`
 *                                              + `buildProMaxArtifacts`
 *   3. draw the nested sample family         → PMX-02 `buildProMaxSampleFamily`
 *
 * It parses no manifest, hashes nothing, and implements no ordering or quota
 * logic of its own. That is the whole point: the ticket requires that "the
 * operator command and runtime both import ONE pure sample-manifest
 * implementation", and the same holds for the corpus split. If this file ever
 * grows its own `JSON.parse` of a dataset row or its own sort, the single-owner
 * property is gone.
 *
 * It is also the ONLY place in the tree where a gold-bearing row is legitimately
 * handled outside the harness — and it never writes one into the agent root,
 * because `writeProMaxArtifacts` refuses an overlapping layout before writing.
 *
 * Usage:
 *   bun run tools/bench-promax/prepare-corpus.ts \
 *     --bundle-root <verified-bundle-dir> \
 *     --head-commit <sha> [--attached-ref <ref>] \
 *     --agent-root <dir> --grader-root <dir> \
 *     [--seed <seed>] [--samples-out <dir>]
 *
 * `--agent-root` receives ONLY `public-tasks.json`. `--grader-root` receives
 * `grader-bundle/` and MUST NOT be inside `--agent-root`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildProMaxArtifacts,
  buildProMaxSampleFamily,
  decodeProMaxOfficialCorpus,
  PROMAX_DEFAULT_SAMPLE_SEED,
  type ProMaxSampleManifest,
  writeProMaxArtifacts,
} from "@/apps/bench/promax/corpus"
import type { ProMaxVerifyPolicy } from "@/apps/bench/promax/provenance"
import { decodeUtf8 } from "@/apps/bench/promax/provenance/digest"
import { BUNDLE_FILES, type CheckoutClaim, verifyBundleDir } from "./verify-bundle"

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const required = (argv: readonly string[], name: string): string => {
  const value = flag(argv, name)
  if (value === undefined || value.trim() === "") {
    throw new Error(`promax prepare: ${name} is required (no default — this writes gold to disk)`)
  }
  return value
}

export interface PrepareResult {
  readonly exitCode: number
  readonly output: string
}

export interface PrepareArgs {
  readonly bundleRoot: string
  readonly checkout: CheckoutClaim
  readonly agentRoot: string
  readonly graderRoot: string
  readonly seed: string
  readonly samplesOut?: string | undefined
  /** TEST/DI seam ONLY — deliberately NOT a CLI flag, exactly as in
   *  `verify-bundle.ts`: an operator must not be able to widen the approved
   *  snapshot set from the command line, which would turn the approval gate into
   *  a suggestion. */
  readonly policy?: ProMaxVerifyPolicy | undefined
}

/**
 * The whole preparation, as one testable function. Returns the verdict text
 * rather than printing, so a caller can assert on it.
 */
export const prepareProMaxCorpus = (args: PrepareArgs): PrepareResult => {
  // 1 — provenance FIRST. A campaign cannot reach dataset parsing without it.
  const verdict = verifyBundleDir(args.bundleRoot, args.checkout, args.policy)
  if (!verdict.ok) {
    return {
      exitCode: 1,
      output: [
        `REFUSED — the frozen bundle did not verify (${verdict.failures.length} failure(s)):`,
        ...verdict.failures.map((f) => `  [${f.code}] ${f.message}`),
      ].join("\n"),
    }
  }

  // 2 — the SPLIT. The same bytes the verifier hashed.
  const datasetText = decodeUtf8(readFileSync(join(args.bundleRoot, BUNDLE_FILES.dataset)))
  const evalText = decodeUtf8(readFileSync(join(args.bundleRoot, BUNDLE_FILES.evalMeta)))
  const decoded = decodeProMaxOfficialCorpus({ datasetText, evalText })
  if (!decoded.ok) {
    return {
      exitCode: 1,
      output: [
        `REFUSED — the corpus did not decode (${decoded.failures.length} failure(s)):`,
        ...decoded.failures.map((f) => `  [${f.code}] ${f.message}`),
      ].join("\n"),
    }
  }

  const artifacts = buildProMaxArtifacts({
    agentTasks: decoded.agentTasks,
    graderTasks: decoded.graderTasks,
    source: {
      manifestSha256: verdict.manifestSha256,
      upstreamGitCommit: verdict.manifest.upstream_git_commit,
      hfDatasetRevision: verdict.manifest.hf_dataset_revision,
      datasetSha256: verdict.manifest.dataset_sha256,
      evalSha256: verdict.manifest.eval_sha256,
    },
  })
  const paths = writeProMaxArtifacts({
    agentRoot: args.agentRoot,
    graderRoot: args.graderRoot,
    publicTasks: artifacts.publicTasks,
    graderBundle: artifacts.graderBundle,
  })

  // 3 — the nested sample family, drawn from PUBLIC data only.
  const samples = buildProMaxSampleFamily({
    candidates: decoded.agentTasks.map((t) => ({
      instanceId: t.instanceId,
      language: t.language,
    })),
    datasetRevision: verdict.manifest.hf_dataset_revision,
    seed: args.seed,
  })
  const samplesOut = args.samplesOut
  if (samplesOut !== undefined) {
    mkdirSync(samplesOut, { recursive: true })
    for (const manifest of samples) {
      writeFileSync(
        join(samplesOut, `${manifest.name}.manifest.json`),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    }
  }

  return { exitCode: 0, output: formatPrepared(paths, artifacts, samples, samplesOut) }
}

const formatPrepared = (
  paths: { publicTasksPath: string; graderBundleDir: string },
  artifacts: ReturnType<typeof buildProMaxArtifacts>,
  samples: readonly ProMaxSampleManifest[],
  samplesOut: string | undefined,
): string =>
  [
    "PREPARED",
    `  public tasks         ${paths.publicTasksPath}`,
    `    instances          ${artifacts.publicTasks.tasks.length}`,
    `    content_sha256     ${artifacts.publicTasks.contentSha256}`,
    `  grader bundle        ${paths.graderBundleDir}`,
    `    instances          ${artifacts.graderBundle.tasks.length}`,
    `    content_sha256     ${artifacts.graderBundle.contentSha256}`,
    `  samples              ${samplesOut ?? "(not written — pass --samples-out)"}`,
    ...samples.map((s) => `    ${s.name.padEnd(8)} n=${s.instanceIds.length}  sha256=${s.sha256}`),
  ].join("\n")

export const runPrepareCli = (argv: readonly string[]): PrepareResult =>
  prepareProMaxCorpus({
    bundleRoot: required(argv, "--bundle-root"),
    checkout: {
      headCommit: flag(argv, "--head-commit") ?? "",
      attachedRef: flag(argv, "--attached-ref"),
    },
    agentRoot: required(argv, "--agent-root"),
    graderRoot: required(argv, "--grader-root"),
    seed: flag(argv, "--seed") ?? PROMAX_DEFAULT_SAMPLE_SEED,
    samplesOut: flag(argv, "--samples-out"),
  })

if (import.meta.main) {
  try {
    const { exitCode, output } = runPrepareCli(process.argv.slice(2))
    process.stdout.write(`${output}\n`)
    process.exit(exitCode)
  } catch (err) {
    process.stderr.write(`promax prepare: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
}
