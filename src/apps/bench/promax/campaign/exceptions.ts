/**
 * PMX-06 — the VERSIONED UPSTREAM-EXCEPTION MANIFEST.
 *
 * Gate 5 wants 170/170 golden `success`. When upstream defects make that
 * impossible the ticket does NOT allow the instance to leave the campaign:
 *
 *   *"If upstream defects prevent 170/170, create a versioned exception manifest
 *   with instance ID, exact raw receipt, upstream issue/reference, owner, and
 *   disposition. Do not delete exceptions from assigned. Campaign readiness then
 *   reports both `170 assigned` and the exact valid/exception coverage."*
 *
 * Two properties make this an audit trail rather than an escape hatch:
 *
 *  1. AN EXCEPTION MUST CORRESPOND TO A REAL FAILURE. An entry for an instance
 *     that is passing is refused (`exception_unjustified`) — nobody may
 *     pre-emptively excuse an instance in case it fails later.
 *  2. AN EXCEPTION MUST STILL BE ASSIGNED. An entry naming an instance the
 *     campaign no longer assigns is refused (`exception_shrinks_assigned`):
 *     deleting the row and filing a note is exactly the denominator shrink the
 *     score contract exists to prevent.
 *
 * Pure data + validation. The gate owns the reconciliation.
 */

/** Why an instance is excepted. Closed: a new disposition must be classified. */
export const PROMAX_EXCEPTION_DISPOSITION_REASONS = {
  upstream_defect: "the pinned upstream evaluator/dataset cannot grade this instance correctly",
  image_unavailable:
    "the instance's upstream image cannot be pulled or does not run on linux/amd64",
  withdrawn_upstream: "upstream has withdrawn or superseded the instance since the pinned commit",
} as const

export type ProMaxExceptionDisposition = keyof typeof PROMAX_EXCEPTION_DISPOSITION_REASONS

export const PROMAX_EXCEPTION_DISPOSITIONS = Object.keys(
  PROMAX_EXCEPTION_DISPOSITION_REASONS,
) as readonly ProMaxExceptionDisposition[]

export interface ProMaxUpstreamException {
  readonly instance_id: string
  /** The EXACT raw receipt text the evaluator produced. Never a summary. */
  readonly raw_receipt: string
  /** An upstream issue/PR/commit reference a reviewer can follow. */
  readonly upstream_reference: string
  /** The human accountable for this exception. */
  readonly owner: string
  readonly disposition: ProMaxExceptionDisposition
  readonly recorded_at: string
}

export interface ProMaxExceptionManifest {
  readonly manifest_version: number
  readonly campaign_id: string
  readonly upstream_git_commit: string
  readonly exceptions: readonly ProMaxUpstreamException[]
}

const blank = (value: unknown): boolean => typeof value !== "string" || value.trim() === ""

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The entries of a manifest, or NONE.
 *
 * This exists because a manifest reaches the gate as untrusted bytes: an
 * operator hands gate 5 a `--exceptions <path>`, and the document on the other
 * end of that path is whatever was written there. Iterating `manifest.exceptions`
 * unguarded turned a missing key into a TypeError inside the gate — an exception
 * list that is not a list must be a REFUSAL (via
 * {@link validateExceptionManifest}, which reports it) and cover nothing, never
 * a crash.
 */
export const exceptionEntriesOf = (
  manifest: ProMaxExceptionManifest,
): readonly ProMaxUpstreamException[] => {
  const raw = isObject(manifest) ? (manifest as Record<string, unknown>).exceptions : undefined
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is ProMaxUpstreamException => isObject(entry))
}

/**
 * Structural validation of one manifest against the campaign that owns it.
 * Returns human problems; the gate decides which failure code they become.
 *
 * The parameter is TYPED but treated as untrusted: this is the boundary where a
 * document read off disk becomes a manifest, so the type is a claim the caller
 * makes, not a fact this function may rely on.
 */
export const validateExceptionManifest = (args: {
  readonly manifest: ProMaxExceptionManifest
  readonly campaignId: string
  readonly upstreamGitCommit: string
  readonly requiredVersion: number
}): readonly string[] => {
  const problems: string[] = []
  const { manifest } = args
  if (!isObject(manifest)) {
    return [
      "the upstream-exception manifest is not a JSON object — an exception list that cannot be " +
        "read excuses nothing, and every shortfall stays uncovered",
    ]
  }
  const rawEntries = (manifest as Record<string, unknown>).exceptions
  if (!Array.isArray(rawEntries)) {
    problems.push(
      "`exceptions` must be an ARRAY of versioned exception entries — a manifest with no readable " +
        "entry list covers no instance",
    )
  } else {
    for (const entry of rawEntries) {
      if (!isObject(entry)) {
        problems.push(
          `an exception entry is ${entry === null ? "null" : typeof entry}, not a record with an ` +
            "instance id, raw receipt, upstream reference, owner and disposition",
        )
      }
    }
  }
  if (manifest.manifest_version !== args.requiredVersion) {
    problems.push(
      `the manifest declares version ${String(manifest.manifest_version)} but this campaign froze ` +
        `exception-policy version ${args.requiredVersion} — an unversioned exception list cannot be reviewed against the run that produced it`,
    )
  }
  if (manifest.campaign_id !== args.campaignId) {
    problems.push(
      `the manifest belongs to campaign "${manifest.campaign_id}", not "${args.campaignId}"`,
    )
  }
  if (manifest.upstream_git_commit !== args.upstreamGitCommit) {
    problems.push(
      `the manifest was written against upstream ${manifest.upstream_git_commit}, not the campaign's ${args.upstreamGitCommit}`,
    )
  }
  const seen = new Set<string>()
  for (const entry of exceptionEntriesOf(manifest)) {
    const id = entry.instance_id
    if (blank(id)) {
      problems.push("an exception names no instance")
      continue
    }
    if (seen.has(id)) problems.push(`instance "${id}" is excepted more than once`)
    seen.add(id)
    if (blank(entry.raw_receipt)) {
      problems.push(`exception "${id}" carries no raw receipt — the evidence IS the exception`)
    }
    if (blank(entry.upstream_reference)) {
      problems.push(`exception "${id}" cites no upstream issue/reference`)
    }
    if (blank(entry.owner)) problems.push(`exception "${id}" names no owner`)
    if (blank(entry.recorded_at)) problems.push(`exception "${id}" has no recorded_at instant`)
    if (!Object.hasOwn(PROMAX_EXCEPTION_DISPOSITION_REASONS, entry.disposition)) {
      problems.push(`exception "${id}" has unknown disposition "${String(entry.disposition)}"`)
    }
  }
  return problems
}
