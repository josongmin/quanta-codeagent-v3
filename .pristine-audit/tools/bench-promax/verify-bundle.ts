/**
 * PMX-00 operator tool — offline `verify` for a frozen ProMax bundle.
 *
 * It reads four files and DELEGATES to the one validator. It parses nothing
 * itself: no manifest schema knowledge, no id logic, no hashing of its own. If
 * this file ever grows a `JSON.parse` of the manifest, the "one owner" property
 * PMX-00 exists to establish is gone.
 *
 * It is an OFFLINE PROVENANCE TOOL, not a bench runner: it cannot launch a run,
 * resolve model/preset knobs, or write a canonical bench report, and it never
 * fetches anything — the caller supplies an already-fetched bundle root.
 *
 * Usage:
 *   bun run tools/bench-promax/verify-bundle.ts --bundle-root <dir> \
 *     [--head-commit <sha> [--attached-ref <ref>]]
 *
 * Expected layout under <dir>: manifest.json, dataset.json, eval.json,
 * evaluator.py, and optionally hf/dataset.json + hf/eval.json.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type {
  ProMaxBundleSources,
  ProMaxVerification,
  ProMaxVerifyPolicy,
} from "@/apps/bench/promax/provenance"
import { requireExplicitBundleRoot, verifyProMaxBundle } from "@/apps/bench/promax/provenance"

/** Names are fixed so a bundle directory is self-describing. */
export const BUNDLE_FILES = Object.freeze({
  manifest: "manifest.json",
  dataset: "dataset.json",
  evalMeta: "eval.json",
  evaluator: "evaluator.py",
  hfDataset: join("hf", "dataset.json"),
  hfEvalMeta: join("hf", "eval.json"),
})

export interface CheckoutClaim {
  readonly headCommit: string
  /** present only when the checkout is ON a ref (i.e. NOT detached). */
  readonly attachedRef?: string | undefined
}

/** Read a bundle directory into the exact byte shape the validator consumes. */
export const readBundleSources = (
  bundleRootRaw: string | undefined,
  checkout: CheckoutClaim,
): ProMaxBundleSources => {
  // fail-closed: never default to a search path or "the latest bundle"
  const root = requireExplicitBundleRoot(bundleRootRaw)
  const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(join(root, rel)))
  const optional = (rel: string): Uint8Array | undefined =>
    existsSync(join(root, rel)) ? read(rel) : undefined

  const hfDataset = optional(BUNDLE_FILES.hfDataset)
  const hfEvalMeta = optional(BUNDLE_FILES.hfEvalMeta)
  return {
    manifest: read(BUNDLE_FILES.manifest),
    dataset: read(BUNDLE_FILES.dataset),
    evalMeta: read(BUNDLE_FILES.evalMeta),
    evaluator: read(BUNDLE_FILES.evaluator),
    ...(hfDataset === undefined ? {} : { hfDataset }),
    ...(hfEvalMeta === undefined ? {} : { hfEvalMeta }),
    checkout: {
      detached: checkout.attachedRef === undefined,
      headCommit: checkout.headCommit,
      ref: checkout.attachedRef,
    },
  }
}

/**
 * The tool's ONLY verdict path — the same function the runtime calls.
 *
 * `policy` is a TEST/DI seam, deliberately NOT a CLI flag: an operator must not
 * be able to widen the approved-snapshot set from the command line, which would
 * turn the approval gate into a suggestion.
 */
export const verifyBundleDir = (
  bundleRoot: string | undefined,
  checkout: CheckoutClaim,
  policy?: ProMaxVerifyPolicy,
): ProMaxVerification => verifyProMaxBundle(readBundleSources(bundleRoot, checkout), policy)

/** Render a verdict for a human. Presentation only; no re-derivation. */
export const formatVerdict = (v: ProMaxVerification): string => {
  if (!v.ok) {
    return [
      `REFUSED (${v.failures.length} failure(s))`,
      ...v.failures.map((f) => `  [${f.code}] ${f.message}`),
    ].join("\n")
  }
  return [
    "VERIFIED",
    `  manifest_sha256      ${v.manifestSha256}`,
    `  upstream_repo_url    ${v.manifest.upstream_repo_url}`,
    `  upstream_git_commit  ${v.manifest.upstream_git_commit}`,
    `  hf_repo_id           ${v.manifest.hf_repo_id}`,
    `  hf_dataset_revision  ${v.manifest.hf_dataset_revision}`,
    `  dataset_sha256       ${v.manifest.dataset_sha256}`,
    `  eval_sha256          ${v.manifest.eval_sha256}`,
    `  evaluator_sha256     ${v.manifest.evaluator_sha256}`,
    `  dataset_count        ${v.manifest.dataset_count}`,
    `  dataset_ids_sha256   ${v.manifest.dataset_ids_sha256}`,
    `  captured_at          ${v.manifest.captured_at}`,
    `  instances            ${v.instanceIds.length}`,
  ].join("\n")
}

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export const runVerifyCli = (
  argv: readonly string[],
  policy?: ProMaxVerifyPolicy,
): { readonly exitCode: number; readonly output: string } => {
  const verdict = verifyBundleDir(
    flag(argv, "--bundle-root"),
    {
      headCommit: flag(argv, "--head-commit") ?? "",
      attachedRef: flag(argv, "--attached-ref"),
    },
    policy,
  )
  return { exitCode: verdict.ok ? 0 : 1, output: formatVerdict(verdict) }
}

if (import.meta.main) {
  try {
    const { exitCode, output } = runVerifyCli(process.argv.slice(2))
    process.stdout.write(`${output}\n`)
    process.exit(exitCode)
  } catch (err) {
    process.stderr.write(`promax verify: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
}
