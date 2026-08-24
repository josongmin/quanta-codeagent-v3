/**
 * PMX-04 — THE COMPOSITION. Selection + corpus → frozen images → campaign golden
 * → the two pre-spend gates.
 *
 * ## Why this module exists
 *
 * Every piece of the image-provenance chain existed and was unit-tested, and
 * NONE of it had a production caller: `deriveCampaignGolden`,
 * `diffGoldenDocuments`, `assertGoldenDerivationIsImageOnly`,
 * `runProMaxImagePreflight` and `assertImageFreezeReadyForModelLaunch` were
 * reachable only from their own tests. A gate with no caller is not a gate — it
 * is a document that describes one. This file is the composition those gates
 * were written for, and `tools/bench-promax/freeze-images.ts` is the operator
 * command that runs it.
 *
 * ## The order, and why it is this order
 *
 * ```text
 *  1 SELECT    upstream golden ─▶ the campaign's rows, in upstream ORDER
 *  2 RESOLVE   mutable tag ─▶ repo@sha256:…              (docker pull + inspect)
 *  3 DERIVE    campaign-golden.json with image_name pinned
 *  4 PREFLIGHT pull/inspect/start/cp/exec per instance ─▶ the freeze RECEIPT
 *  5 GATE      the receipt is launch-ready (digest-pinned, platform, coverage)
 *  6 PROVE     the derived golden is image-only AND pinned at the RECEIPT's
 *              digests — the receipt is the authority, not step 2's own memory
 * ```
 *
 * Step 3 precedes step 4 because the receipt records both golden digests, and
 * step 6 follows step 5 because the document that ships must be proven against
 * the artefact that justifies it. Every step FAILS CLOSED, and every refusal
 * names the stage it happened at so an operator is never left with "the freeze
 * failed".
 *
 * ## Boundary
 *
 * Pure except for the INJECTED {@link DockerPort}. No filesystem, no clock of
 * its own, no network: reading the bundle and writing the artefacts belong to
 * the operator command. That is what lets the whole chain — including the two
 * `docker` steps — be driven by a recording fake in a unit test.
 */

import { sha256Hex } from "@/apps/bench/promax/provenance"
import { errMessage } from "@/shared"
import {
  assertGoldenDerivationIsImageOnly,
  type CampaignGoldenPin,
  deriveCampaignGolden,
  diffGoldenDocuments,
} from "./golden-derive"
import {
  assertImageFreezeReadyForModelLaunch,
  isDigestPinnedReference,
  PROMAX_REQUIRED_ARCHITECTURE,
  PROMAX_REQUIRED_OS,
  type ProMaxImageFreezeReceipt,
} from "./image-freeze"
import { type DockerPort, type ProMaxImageTarget, runProMaxImagePreflight } from "./image-preflight"

/** The step a refusal happened at. Closed so a caller can branch exhaustively. */
export type ProMaxFreezeStage =
  | "select"
  | "resolve"
  | "derive"
  | "preflight"
  | "launch_gate"
  | "golden_proof"

/**
 * Human reason per stage. `Record<ProMaxFreezeStage, string>` is the
 * exhaustiveness lever: a new stage that is not explained here is a COMPILE
 * error rather than an unexplained campaign refusal.
 */
export const PROMAX_FREEZE_STAGE_REASONS: Record<ProMaxFreezeStage, string> = {
  select: "the assigned instances could not be cut out of the upstream golden document",
  resolve: "a source image tag could not be resolved to a registry digest",
  derive: "the campaign-local golden document could not be derived",
  preflight: "the Docker preflight recorded faults",
  launch_gate: "the image-freeze receipt is not launch-ready",
  golden_proof: "the derived golden is not a pure, digest-pinned image substitution",
}

/** Runtime drift guard companion — pins the table in the other direction. */
export const PROMAX_FREEZE_STAGES = Object.keys(
  PROMAX_FREEZE_STAGE_REASONS,
) as readonly ProMaxFreezeStage[]

export interface ProMaxCampaignFreezeInput {
  readonly campaignId: string
  readonly upstreamGitCommit: string
  /** The RESOLVED sample selection — what this campaign is accountable for. */
  readonly assignedInstanceIds: readonly string[]
  /** The verified upstream golden document's EXACT bytes (`dataset.json`). */
  readonly upstreamGoldenText: string
  /**
   * instanceId → `image_name`, read from the GRADER BUNDLE.
   *
   * Deliberately a second source for a value the golden row also carries: the
   * bundle and the golden are two projections of one upstream row, so a
   * disagreement means one of them was edited and neither may be trusted.
   */
  readonly graderImageNames: ReadonlyMap<string, string>
  readonly docker: DockerPort
  readonly now: () => Date
  readonly probeFilePath: string
  /** Where the campaign's source-golden slice will be written. */
  readonly campaignGoldenSourcePath: string
  /** Where the derived `campaign-golden.json` will be written. */
  readonly campaignGoldenDerivedPath: string
}

export interface ProMaxCampaignFrozen {
  readonly ok: true
  readonly receipt: ProMaxImageFreezeReceipt
  /** The order-preserving slice of the upstream golden this campaign grades. */
  readonly campaignGoldenSourceJson: string
  /** The digest-pinned document the pinned evaluator will read. */
  readonly campaignGoldenDerivedJson: string
  /** sha256 of the FULL upstream document the slice was cut from. */
  readonly upstreamGoldenSha256: string
  readonly pins: readonly CampaignGoldenPin[]
}

export interface ProMaxCampaignFreezeRefused {
  readonly ok: false
  readonly stage: ProMaxFreezeStage
  readonly problems: readonly string[]
  /** Present from the preflight stage onward — evidence survives a refusal. */
  readonly receipt?: ProMaxImageFreezeReceipt
}

export type ProMaxCampaignFreeze = ProMaxCampaignFrozen | ProMaxCampaignFreezeRefused

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== ""

const refuse = (stage: ProMaxFreezeStage, problems: readonly string[]): ProMaxCampaignFreeze => ({
  ok: false,
  stage,
  problems,
})

interface SelectedRow {
  readonly instanceId: string
  readonly imageName: string
  readonly row: Record<string, unknown>
}

/**
 * The verdict on ONE upstream golden row: not ours (`skip`), ours but unusable
 * (`problem`, carrying the operator-facing reason), or ours and pinnable (`row`).
 */
type GoldenRowVerdict =
  | { readonly kind: "skip" }
  | { readonly kind: "problem"; readonly problem: string }
  | { readonly kind: "row"; readonly row: SelectedRow }

/**
 * Decide what ONE upstream golden row is worth to the freeze.
 *
 * A unit because every rejection here answers the same question — "can this row be
 * trusted to pin an image?" — and they are ordered, not independent: a duplicate is
 * reported before its image is read, and the two projections of the row (golden
 * document and grader bundle) are compared only once both are known present. Splitting
 * them apart would let a row be pinned off a check that had not run yet.
 *
 * `found` is mutated here on purpose: "have we already claimed this instance" is part
 * of the row's verdict, not a bookkeeping detail the caller can be trusted to repeat.
 */
const classifyGoldenRow = (
  raw: unknown,
  assigned: ReadonlySet<string>,
  found: Set<string>,
  graderImageNames: ReadonlyMap<string, string>,
): GoldenRowVerdict => {
  if (!isRecord(raw)) return { kind: "skip" }
  const instanceId = raw.instance_id
  if (!nonBlank(instanceId) || !assigned.has(instanceId)) return { kind: "skip" }
  if (found.has(instanceId)) {
    return {
      kind: "problem",
      problem: `instance "${instanceId}" appears more than once in the upstream golden document — two rows would race for one image pin`,
    }
  }
  found.add(instanceId)
  const imageName = raw.image_name
  if (!nonBlank(imageName)) {
    // Upstream substitutes `key4127/refactor-dockerhub:<id>` for a falsy
    // value, so a blank here is not "no image" — it is a SILENT mutable tag.
    return {
      kind: "problem",
      problem: `instance "${instanceId}" has an absent or blank \`image_name\``,
    }
  }
  const fromBundle = graderImageNames.get(instanceId)
  if (fromBundle === undefined) {
    return {
      kind: "problem",
      problem: `instance "${instanceId}" is assigned and present in the golden document, but the grader bundle has no record for it`,
    }
  }
  if (fromBundle !== imageName) {
    return {
      kind: "problem",
      problem:
        `instance "${instanceId}": the golden document says image_name "${imageName}" but the grader bundle says ` +
        `"${fromBundle}" — the two projections of one upstream row disagree, so neither may be trusted`,
    }
  }
  return { kind: "row", row: { instanceId, imageName, row: raw } }
}

/**
 * Cut the campaign's rows out of the upstream document, PRESERVING upstream
 * order, and cross-check each row's `image_name` against the grader bundle's.
 *
 * Order is preserved rather than following the selection's order because the
 * structural diff in step 6 treats a reordered row as a violation — the slice
 * must be a subsequence of upstream, not a permutation of it.
 */
const selectCampaignRows = (
  input: ProMaxCampaignFreezeInput,
): { readonly ok: true; readonly rows: readonly SelectedRow[] } | ProMaxCampaignFreezeRefused => {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.upstreamGoldenText)
  } catch (err) {
    return {
      ok: false,
      stage: "select",
      problems: [`the upstream golden document is not valid JSON: ${errMessage(err)}`],
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      stage: "select",
      problems: ["the upstream golden document is not a JSON array (upstream's `--golden` form)"],
    }
  }

  const assigned = new Set(input.assignedInstanceIds)
  const problems: string[] = []
  const rows: SelectedRow[] = []
  const found = new Set<string>()

  for (const raw of parsed) {
    const verdict = classifyGoldenRow(raw, assigned, found, input.graderImageNames)
    if (verdict.kind === "problem") problems.push(verdict.problem)
    else if (verdict.kind === "row") rows.push(verdict.row)
  }

  // An assigned instance with NO golden row is deliberately NOT refused here.
  // It produces no target, hence no image record, and the LAUNCH GATE is the one
  // owner of "the freeze covers exactly the assigned set" — one rule, one place,
  // and the gate is load-bearing on the real path instead of shadowed by a
  // duplicate check upstream of it.
  if (problems.length > 0) return { ok: false, stage: "select", problems }
  return { ok: true, rows }
}

/** The repository half of a reference — `repo:tag` and `repo@sha256:…` both. */
const repositoryOf = (reference: string): string => {
  const at = reference.indexOf("@")
  const base = at >= 0 ? reference.slice(0, at) : reference
  const colon = base.lastIndexOf(":")
  const slash = base.lastIndexOf("/")
  return colon > slash ? base.slice(0, colon) : base
}

/**
 * Resolve one mutable tag to the repo digest the registry serves TODAY.
 *
 * `docker pull` then `docker image inspect` is the resolution, deliberately: it
 * is the same pair the preflight re-runs against the resulting digest, so a tag
 * that resolves to something the daemon cannot then verify is caught twice
 * rather than trusted once. A reference that is ALREADY digest-addressed is
 * returned untouched — there is nothing to resolve and nothing to pull yet.
 */
const resolveDigest = async (
  docker: DockerPort,
  selected: SelectedRow,
): Promise<{ readonly digest: string } | { readonly problem: string }> => {
  if (isDigestPinnedReference(selected.imageName)) return { digest: selected.imageName }

  // aug-23: the tag→digest resolve pull MUST name the required platform, for the
  // same reason the preflight pull does. Without it `docker pull` resolves the
  // manifest list against the HOST, so on a non-amd64 machine this stage refuses
  // every ProMax image with `no matching manifest for linux/arm64/v8` — measured
  // 7/7 on PMX-7 — and a campaign can never be prepared from such a host even
  // though the images it wants exist.
  const pull = await docker([
    "pull",
    "--platform",
    `${PROMAX_REQUIRED_OS}/${PROMAX_REQUIRED_ARCHITECTURE}`,
    selected.imageName,
  ])
  if (pull.code !== 0) {
    return {
      problem:
        `instance "${selected.instanceId}": \`docker pull ${selected.imageName}\` exited ${pull.code}` +
        `${pull.stderr.trim() === "" ? "" : `: ${pull.stderr.trim()}`}`,
    }
  }
  const inspect = await docker(["image", "inspect", "--format", "{{json .}}", selected.imageName])
  if (inspect.code !== 0) {
    return {
      problem: `instance "${selected.instanceId}": \`docker image inspect ${selected.imageName}\` exited ${inspect.code}`,
    }
  }
  let facts: unknown
  try {
    facts = JSON.parse(inspect.stdout.split("\n").find((l) => l.trim() !== "") ?? "")
  } catch (e) {
    // The refusal was already loud, but it carried neither the parse fault nor
    // the offending bytes, so an operator could not tell a truncated stream from
    // a docker whose `--format` output shape changed under them.
    return {
      problem:
        `instance "${selected.instanceId}": \`docker image inspect\` did not emit a JSON object: ` +
        errMessage(e),
    }
  }
  const digests = isRecord(facts) && Array.isArray(facts.RepoDigests) ? facts.RepoDigests : []
  const repository = repositoryOf(selected.imageName)
  const matching = digests.filter(
    (d): d is string =>
      typeof d === "string" && isDigestPinnedReference(d) && repositoryOf(d) === repository,
  )
  const only = matching[0]
  if (only === undefined) {
    return {
      problem:
        `instance "${selected.instanceId}": tag "${selected.imageName}" resolved to NO repo digest for repository ` +
        `"${repository}" (RepoDigests=[${digests.join(", ")}]) — an image that was never pushed cannot be replayed`,
    }
  }
  if (matching.length > 1) {
    return {
      problem:
        `instance "${selected.instanceId}": tag "${selected.imageName}" resolved to ${matching.length} digests for one ` +
        `repository ([${matching.join(", ")}]) — the campaign cannot choose one for you`,
    }
  }
  return { digest: only }
}

/**
 * Freeze a ProMax campaign's images and derive its golden document, or refuse.
 *
 * SERIAL by construction, for the same reason the preflight is: `docker pull` on
 * a box whose disk headroom is the binding constraint must not interleave.
 */
export const freezeProMaxCampaignImages = async (
  input: ProMaxCampaignFreezeInput,
): Promise<ProMaxCampaignFreeze> => {
  // 1 — SELECT
  const selected = selectCampaignRows(input)
  if (!selected.ok) return selected
  const campaignGoldenSourceJson = JSON.stringify(
    selected.rows.map((r) => r.row),
    null,
    2,
  )

  // 2 — RESOLVE
  const targets: ProMaxImageTarget[] = []
  const resolveProblems: string[] = []
  for (const row of selected.rows) {
    const outcome = await resolveDigest(input.docker, row)
    if ("problem" in outcome) {
      resolveProblems.push(outcome.problem)
      continue
    }
    targets.push({
      instanceId: row.instanceId,
      sourceImageName: row.imageName,
      registryRepoDigest: outcome.digest,
    })
  }
  if (resolveProblems.length > 0) return refuse("resolve", resolveProblems)

  // 3 — DERIVE
  const pins: readonly CampaignGoldenPin[] = targets.map((t) => ({
    instanceId: t.instanceId,
    pinnedReference: t.registryRepoDigest,
  }))
  const derived = deriveCampaignGolden({ sourceText: campaignGoldenSourceJson, pins })
  if (!derived.ok) {
    return refuse(
      "derive",
      derived.failures.map((f) => `[${f.code}] ${f.message}`),
    )
  }

  // 4 — PREFLIGHT
  const receipt = await runProMaxImagePreflight({
    campaignId: input.campaignId,
    upstreamGitCommit: input.upstreamGitCommit,
    targets,
    docker: input.docker,
    now: input.now,
    probeFilePath: input.probeFilePath,
    goldenSource: {
      path: input.campaignGoldenSourcePath,
      sha256: sha256Hex(campaignGoldenSourceJson),
    },
    goldenDerived: { path: input.campaignGoldenDerivedPath, sha256: derived.derivedSha256 },
  })

  // 5 + 6 — the two GATES, through the one admission function the `--verify`
  // path also uses.
  const admitted = admitProMaxCampaignForLaunch({
    receipt,
    assignedInstanceIds: input.assignedInstanceIds,
    campaignGoldenSourceText: campaignGoldenSourceJson,
    campaignGoldenDerivedText: derived.json,
  })
  if (!admitted.ok) return { ...admitted, receipt }

  return {
    ok: true,
    receipt,
    campaignGoldenSourceJson,
    campaignGoldenDerivedJson: derived.json,
    upstreamGoldenSha256: sha256Hex(input.upstreamGoldenText),
    pins: pinsOf(receipt),
  }
}

/** The pins a RECEIPT asserts — the authority for what the golden may pin to. */
const pinsOf = (receipt: ProMaxImageFreezeReceipt): readonly CampaignGoldenPin[] =>
  receipt.images.map((i) => ({
    instanceId: i.instance_id,
    pinnedReference: i.registry_repo_digest,
  }))

export interface ProMaxCampaignAdmissionInput {
  readonly receipt: ProMaxImageFreezeReceipt
  /** The set the campaign is accountable for — the resolved sample selection. */
  readonly assignedInstanceIds: readonly string[]
  /** The EXACT bytes of the campaign's source-golden slice. */
  readonly campaignGoldenSourceText: string
  /** The EXACT bytes of the derived `campaign-golden.json`. */
  readonly campaignGoldenDerivedText: string
}

/**
 * ADMIT a campaign for a model launch, from artefacts ALONE.
 *
 * This is where the two gates earn their keep. Inside a freeze they are a
 * backstop — the same process derived everything a moment earlier — but this
 * function is also the `--verify` path, which re-reads three files off disk and
 * re-proves them: a receipt from another campaign, a `campaign-golden.json`
 * whose digest was hand-swapped back to a mutable tag, or a golden whose gold
 * `patch` was edited after the freeze all arrive here as bytes with no
 * privileged history.
 *
 * The digest BINDING is what makes that possible: the receipt records the sha256
 * of both documents, so the artefacts cannot be edited independently of the
 * receipt that vouches for them. Every problem found is reported, not just the
 * first — an operator re-proving a campaign should see the whole picture.
 */
export const admitProMaxCampaignForLaunch = (
  input: ProMaxCampaignAdmissionInput,
): { readonly ok: true } | ProMaxCampaignFreezeRefused => {
  try {
    assertImageFreezeReadyForModelLaunch(input.receipt, input.assignedInstanceIds)
  } catch (err) {
    return {
      ok: false,
      // A faulted receipt failed at the PREFLIGHT; a fault-free one that the gate
      // still refuses failed at the gate. Same refusal, different owner.
      stage: input.receipt.faults.length > 0 ? "preflight" : "launch_gate",
      problems: [errMessage(err)],
      receipt: input.receipt,
    }
  }

  const problems: string[] = []
  const sourceSha = sha256Hex(input.campaignGoldenSourceText)
  if (sourceSha !== input.receipt.golden_source.sha256) {
    problems.push(
      `the campaign source golden hashes to ${sourceSha}, but the freeze receipt vouches for ` +
        `${input.receipt.golden_source.sha256} (${input.receipt.golden_source.path}) — the document and its receipt disagree`,
    )
  }
  const derivedSha = sha256Hex(input.campaignGoldenDerivedText)
  if (derivedSha !== input.receipt.golden_derived.sha256) {
    problems.push(
      `the derived campaign golden hashes to ${derivedSha}, but the freeze receipt vouches for ` +
        `${input.receipt.golden_derived.sha256} (${input.receipt.golden_derived.path}) — the document and its receipt disagree`,
    )
  }
  problems.push(
    ...assertGoldenDerivationIsImageOnly(
      diffGoldenDocuments(input.campaignGoldenSourceText, input.campaignGoldenDerivedText),
      pinsOf(input.receipt),
    ),
  )
  if (problems.length > 0) {
    return { ok: false, stage: "golden_proof", problems, receipt: input.receipt }
  }
  return { ok: true }
}
