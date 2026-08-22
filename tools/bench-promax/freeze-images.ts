/**
 * PMX-04 operator tool — FREEZE a ProMax campaign's images, before tokens.
 *
 * This is the production caller of the image-provenance chain. It reads three
 * already-prepared inputs and DELEGATES every decision to
 * `harness/promax/campaign-freeze.ts`:
 *
 *   1. the verified frozen bundle   → PMX-00 `verifyProMaxBundle`
 *   2. the grader bundle            → PMX-02 `openProMaxGraderBundle`
 *   3. the sample manifest          → PMX-02 `selectProMaxSampleIds`
 *                                   → PMX-04 `freezeProMaxCampaignImages`
 *
 * It classifies nothing, hashes nothing, resolves no digest and derives no
 * golden of its own: if this file ever grows a `RepoDigests` read or a second
 * `image_name` substitution, the single-owner property PMX-04 exists to
 * establish is gone. What it owns is IO — reading the three inputs and writing
 * the three artefacts — plus the operator's text.
 *
 * Usage:
 *   bun run tools/bench-promax/freeze-images.ts \
 *     --bundle-root <verified-bundle-dir> --head-commit <sha> [--attached-ref <ref>] \
 *     --grader-root <dir> --out <dir> \
 *     (--sample <manifest.json> | --instance <id[,id…]>) \
 *     [--campaign-id <id>]
 *
 * ⚠️ SPEND SAFETY. `docker pull` runs on the machine this command is invoked on,
 * against images the verified corpus names — it never provisions, never uploads,
 * and never spends a model token. The Docker boundary is INJECTED
 * ({@link FreezeArgs.docker}); the default is bound at `import.meta.main` only,
 * so a test drives the whole command with a recording fake.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type DockerSpawn, defaultDockerSpawn } from "@/apps/bench/harness/images"
import {
  admitProMaxCampaignForLaunch,
  freezeProMaxCampaignImages,
  parseProMaxImageFreezeReceipt,
  serializeProMaxImageFreezeReceipt,
} from "@/apps/bench/harness/promax"
import {
  openProMaxGraderBundle,
  PROMAX_GRADER_BUNDLE_DIR,
  PROMAX_GRADER_TASKS_FILE,
  selectProMaxSampleIds,
} from "@/apps/bench/promax/corpus"
import type { ProMaxVerifyPolicy } from "@/apps/bench/promax/provenance"
import { decodeUtf8 } from "@/apps/bench/promax/provenance/digest"
import { BUNDLE_FILES, type CheckoutClaim, verifyBundleDir } from "./verify-bundle"

/** Artefact names, fixed so a campaign directory is self-describing. */
export const FREEZE_FILES = Object.freeze({
  /** The order-preserving slice of upstream this campaign grades. */
  campaignGoldenSource: "campaign-golden-source.json",
  /** What the pinned evaluator reads: the same rows, digest-pinned. */
  campaignGolden: "campaign-golden.json",
  /** Invariant 6's per-instance record set. */
  receipt: "image-freeze-receipt.json",
  /** The file the `docker cp` proof ships into each disposable container. */
  probe: "preflight-probe.txt",
})

export interface FreezeArgs {
  readonly bundleRoot: string
  readonly checkout: CheckoutClaim
  readonly graderRoot: string
  readonly outRoot: string
  readonly campaignId: string
  /** Explicit ids; mutually exclusive with `samplePath`. */
  readonly instanceIds?: readonly string[] | undefined
  readonly samplePath?: string | undefined
  /** INJECTED process boundary. */
  readonly docker: DockerSpawn
  readonly now?: (() => Date) | undefined
  /** TEST/DI seam ONLY — never a CLI flag, exactly as in `verify-bundle.ts`. */
  readonly policy?: ProMaxVerifyPolicy | undefined
}

export interface FreezeResult {
  readonly exitCode: number
  readonly output: string
}

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const required = (argv: readonly string[], name: string): string => {
  const value = flag(argv, name)
  if (value === undefined || value.trim() === "") {
    throw new Error(`promax freeze: ${name} is required (no default — this pulls real images)`)
  }
  return value
}

const refused = (headline: string, problems: readonly string[]): FreezeResult => ({
  exitCode: 1,
  output: [headline, ...problems.map((p) => `  ${p}`)].join("\n"),
})

/**
 * The whole freeze, as one testable function. Returns the operator text rather
 * than printing, so a caller can assert on it.
 */
export const freezeProMaxCampaign = async (args: FreezeArgs): Promise<FreezeResult> => {
  // 1 — PROVENANCE FIRST. A campaign cannot reach image resolution without it.
  const verdict = verifyBundleDir(args.bundleRoot, args.checkout, args.policy)
  if (!verdict.ok) {
    return refused(
      `REFUSED — the frozen bundle did not verify (${verdict.failures.length} failure(s)):`,
      verdict.failures.map((f) => `[${f.code}] ${f.message}`),
    )
  }

  // 2 — the grader bundle owns `image_name`; the golden document owns the row.
  const bundle = openProMaxGraderBundle(
    readFileSync(join(args.graderRoot, PROMAX_GRADER_BUNDLE_DIR, PROMAX_GRADER_TASKS_FILE), "utf8"),
  )
  const graderImageNames = new Map<string, string>()
  for (const id of bundle.instanceIds) graderImageNames.set(id, bundle.resolve(id).imageName)

  // 3 — the SELECTION, from the one sample-manifest implementation.
  const assignedInstanceIds =
    args.samplePath === undefined
      ? (args.instanceIds ?? [])
      : selectProMaxSampleIds({
          manifestText: readFileSync(args.samplePath, "utf8"),
          manifestPath: args.samplePath,
          availableInstanceIds: [...bundle.instanceIds],
          datasetRevision: verdict.manifest.hf_dataset_revision,
          surface: "promax-freeze",
        })
  if (assignedInstanceIds.length === 0) {
    return refused("REFUSED — no instances selected:", [
      "pass --sample <manifest.json> or --instance <id[,id…]>. REFUSING to freeze an empty campaign, " +
        "which would produce a launch-ready receipt covering nothing.",
    ])
  }

  mkdirSync(args.outRoot, { recursive: true })
  const probePath = join(args.outRoot, FREEZE_FILES.probe)
  writeFileSync(probePath, `quanta promax preflight probe ${args.campaignId}\n`)

  // 4 — THE COMPOSITION. Every gate fires in here.
  const frozen = await freezeProMaxCampaignImages({
    campaignId: args.campaignId,
    upstreamGitCommit: verdict.manifest.upstream_git_commit,
    assignedInstanceIds,
    upstreamGoldenText: decodeUtf8(readFileSync(join(args.bundleRoot, BUNDLE_FILES.dataset))),
    graderImageNames,
    docker: args.docker,
    now: args.now ?? (() => new Date()),
    probeFilePath: probePath,
    campaignGoldenSourcePath: join(args.outRoot, FREEZE_FILES.campaignGoldenSource),
    campaignGoldenDerivedPath: join(args.outRoot, FREEZE_FILES.campaignGolden),
  })

  if (!frozen.ok) {
    // The receipt is EVIDENCE and survives the refusal: an operator debugging a
    // faulted freeze needs the argv and exit codes, not just the verdict.
    if (frozen.receipt !== undefined) {
      writeFileSync(
        join(args.outRoot, FREEZE_FILES.receipt),
        `${serializeProMaxImageFreezeReceipt(frozen.receipt)}\n`,
      )
    }
    return refused(
      `REFUSED at stage "${frozen.stage}" (${frozen.problems.length} problem(s)):`,
      frozen.problems,
    )
  }

  // Written VERBATIM — no trailing newline is appended. The receipt records the
  // sha256 of these exact bytes, and `--verify` re-hashes the file it finds; a
  // cosmetic newline would break that binding for the sake of a text editor.
  writeFileSync(
    join(args.outRoot, FREEZE_FILES.campaignGoldenSource),
    frozen.campaignGoldenSourceJson,
  )
  writeFileSync(join(args.outRoot, FREEZE_FILES.campaignGolden), frozen.campaignGoldenDerivedJson)
  writeFileSync(
    join(args.outRoot, FREEZE_FILES.receipt),
    `${serializeProMaxImageFreezeReceipt(frozen.receipt)}\n`,
  )

  return {
    exitCode: 0,
    output: [
      "FROZEN",
      `  campaign_id          ${args.campaignId}`,
      `  upstream_git_commit  ${verdict.manifest.upstream_git_commit}`,
      `  assigned             ${assignedInstanceIds.length}`,
      `  images               ${frozen.receipt.images.length} (all digest-pinned)`,
      `  upstream_golden      sha256=${frozen.upstreamGoldenSha256}`,
      `  campaign golden src  ${join(args.outRoot, FREEZE_FILES.campaignGoldenSource)}`,
      `  campaign golden      ${join(args.outRoot, FREEZE_FILES.campaignGolden)}`,
      `  image receipt        ${join(args.outRoot, FREEZE_FILES.receipt)}`,
      ...frozen.pins.map((p) => `    ${p.instanceId.padEnd(34)} ${p.pinnedReference}`),
    ].join("\n"),
  }
}

export interface VerifyFreezeArgs {
  readonly outRoot: string
  readonly assignedInstanceIds: readonly string[]
}

/**
 * RE-PROVE an already-frozen campaign from its three artefacts, with no Docker
 * at all.
 *
 * This is the half that makes the two gates load-bearing rather than a
 * self-consistency check: the bytes it reads have no privileged history, so a
 * `campaign-golden.json` whose digest was swapped back to a mutable tag, a
 * receipt borrowed from another campaign, and an edited gold `patch` are all
 * refused HERE — after the freeze, before a token is spent.
 */
export const verifyFrozenProMaxCampaign = (args: VerifyFreezeArgs): FreezeResult => {
  const parsed = parseProMaxImageFreezeReceipt(
    readFileSync(join(args.outRoot, FREEZE_FILES.receipt), "utf8"),
  )
  if (!parsed.ok) {
    return refused(
      `REFUSED — the image-freeze receipt did not parse (${parsed.failures.length} failure(s)):`,
      parsed.failures.map((f) => `[${f.code}] ${f.message}`),
    )
  }
  const admitted = admitProMaxCampaignForLaunch({
    receipt: parsed.receipt,
    assignedInstanceIds: args.assignedInstanceIds,
    campaignGoldenSourceText: readFileSync(
      join(args.outRoot, FREEZE_FILES.campaignGoldenSource),
      "utf8",
    ),
    campaignGoldenDerivedText: readFileSync(
      join(args.outRoot, FREEZE_FILES.campaignGolden),
      "utf8",
    ),
  })
  if (!admitted.ok) {
    return refused(
      `REFUSED at stage "${admitted.stage}" (${admitted.problems.length} problem(s)):`,
      admitted.problems,
    )
  }
  return {
    exitCode: 0,
    output: [
      "ADMITTED",
      `  campaign_id          ${parsed.receipt.campaign_id}`,
      `  assigned             ${args.assignedInstanceIds.length}`,
      `  images               ${parsed.receipt.images.length} (all digest-pinned)`,
      `  golden_source        sha256=${parsed.receipt.golden_source.sha256}`,
      `  golden_derived       sha256=${parsed.receipt.golden_derived.sha256}`,
    ].join("\n"),
  }
}

export const runFreezeCli = async (
  argv: readonly string[],
  docker: DockerSpawn,
): Promise<FreezeResult> => {
  const instance = flag(argv, "--instance")
  if (argv.includes("--verify")) {
    const ids = (instance ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
    if (ids.length === 0) {
      throw new Error(
        "promax freeze --verify: --instance <id[,id…]> is required — re-proving a campaign against " +
          "an unstated assigned set would check coverage against whatever came back",
      )
    }
    return verifyFrozenProMaxCampaign({
      outRoot: required(argv, "--out"),
      assignedInstanceIds: ids,
    })
  }
  return await freezeProMaxCampaign({
    bundleRoot: required(argv, "--bundle-root"),
    checkout: {
      headCommit: flag(argv, "--head-commit") ?? "",
      attachedRef: flag(argv, "--attached-ref"),
    },
    graderRoot: required(argv, "--grader-root"),
    outRoot: required(argv, "--out"),
    campaignId: flag(argv, "--campaign-id") ?? `promax-${new Date().toISOString()}`,
    ...(instance === undefined
      ? {}
      : {
          instanceIds: instance
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
        }),
    samplePath: flag(argv, "--sample"),
    docker,
  })
}

if (import.meta.main) {
  try {
    const { exitCode, output } = await runFreezeCli(process.argv.slice(2), defaultDockerSpawn)
    process.stdout.write(`${output}\n`)
    process.exit(exitCode)
  } catch (err) {
    process.stderr.write(`promax freeze: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
}
