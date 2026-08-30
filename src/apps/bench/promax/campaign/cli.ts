/**
 * PMX-06 — THE OPERATOR COMMAND, as a pure core.
 *
 * This is the production caller the gates were written for. `tools/bench-promax/
 * campaign-gates.ts` binds real filesystem ports to it and nothing else, so the
 * whole promotion policy — the owner audit, the verification rails, the frozen
 * record, and the six gates — is exercisable end to end in a unit test.
 *
 * ## Two subcommands
 *
 * ```text
 *  freeze --input <campaign-input.json> --out <campaign-record.json>
 *      resolves the repository snapshot and source-owner audit itself, then
 *      writes one content-addressed record. It refuses a dirty or moving tree.
 *
 *  preflight --record <path>
 *      the source-owner audit (unclassified duplicates BLOCK live spend),
 *      the verification rails (no command may pass over an empty selection),
 *      and the frozen campaign record, re-verified against its own digest.
 *
 *  gate --gate <id> --record <path> --evidence <path>
 *       [--exceptions <path>] [--prior <path>] [--out <path>]
 *      evaluate ONE gate from artefact bytes and write its result receipt.
 * ```
 *
 * ## Spend safety, by construction
 *
 * {@link CampaignCliPorts} has three members: read a file, write a file, log a
 * line. There is no process port, no Docker port, no network. This command
 * CANNOT provision, pull, upload, or bill — not as a policy, as a type.
 *
 * Exit codes: 0 admitted, 1 refused. A refusal always names the codes.
 */
import { errMessage } from "@/shared"
import {
  decodeProMaxArmEvidence,
  decodeProMaxChunks,
  decodeProMaxGateResults,
  decodeProMaxModelStageEvidence,
  decodeProMaxStageEvidence,
} from "./evidence-decode"
import type { ProMaxExceptionManifest } from "./exceptions"
import {
  admitProMaxFullRun,
  evaluateProMaxCanaryGate,
  evaluateProMaxGoldGate,
  evaluateProMaxModelSmokeGate,
  evaluateProMaxPairedGate,
  PROMAX_GATE_ORDER,
  PROMAX_GATE_SAMPLE,
  type ProMaxGateId,
  type ProMaxGateResult,
} from "./gates"
import {
  assertOwnerAuditAdmitsLiveSpend,
  auditProMaxSourceOwners,
  collectOwnerAuditSources,
} from "./owner-audit"
import { assertRailSelectionsNonEmpty, resolveProMaxVerificationRails } from "./rails"
import {
  type FreezeProMaxCampaignInput,
  freezeProMaxCampaignRecord,
  type ProMaxCampaignRecordResult,
  type ProMaxFrozenCampaignRecord,
  parseProMaxCampaignRecord,
  serializeProMaxCampaignRecord,
} from "./record"

/** The ONLY capabilities this command has. Read, write, log. */
export interface CampaignCliPorts {
  readonly repoRoot: string
  readonly readFile: (path: string) => string
  readonly writeFile: (path: string, text: string) => void
  readonly log: (line: string) => void
  /** Read-only repository identity injected by the outer command. */
  readonly sourceSnapshot?: () => { readonly sha: string; readonly dirty: boolean }
}

const flag = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith("--") ? undefined : value
}

const readJson = (
  ports: CampaignCliPorts,
  path: string,
  label: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } => {
  let text: string
  try {
    text = ports.readFile(path)
  } catch (err) {
    return {
      ok: false,
      message: `bench: the ${label} at ${path} could not be read (${errMessage(err)})`,
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (err) {
    return {
      ok: false,
      message: `bench: the ${label} at ${path} is not valid JSON (${errMessage(err)})`,
    }
  }
}

/**
 * Load the frozen record, or explain why a gated run may not proceed. Recording
 * the campaign inputs is a PRECONDITION: there is deliberately no "run without
 * a record" path.
 */
const loadRecord = (
  ports: CampaignCliPorts,
  path: string | undefined,
):
  | { readonly ok: true; readonly record: ProMaxFrozenCampaignRecord }
  | { readonly ok: false; readonly message: string } => {
  if (path === undefined) {
    return {
      ok: false,
      message:
        "bench: --record <campaign-record.json> is REQUIRED. Freezing the campaign inputs is a " +
        "precondition of every gate; there is no ungated path.",
    }
  }
  const doc = readJson(ports, path, "frozen campaign record")
  if (!doc.ok) return { ok: false, message: doc.message }
  const parsed = parseProMaxCampaignRecord(JSON.stringify(doc.value))
  if (!parsed.ok) {
    return {
      ok: false,
      message: `bench: ${path} is not a usable frozen campaign record — ${parsed.failures
        .map((f) => `${f.code}: ${f.message}`)
        .join(" | ")}`,
    }
  }
  return { ok: true, record: parsed.record }
}

const runPreflight = (argv: readonly string[], ports: CampaignCliPorts): number => {
  const problems: string[] = []

  const audit = auditProMaxSourceOwners(collectOwnerAuditSources(ports.repoRoot))
  ports.log(
    `[promax] owner-audit: ${audit.hits.length} hit(s), ${audit.unclassified.length} unclassified, ` +
      `counters raw-family-env=${audit.final.rawFamilyEnvReads} ` +
      `promax-branches=${audit.final.promaxBranchesOutsideProfile} ` +
      `legacy-verdict-consumers=${audit.final.legacyVerdictConsumers}`,
  )
  try {
    assertOwnerAuditAdmitsLiveSpend(audit)
  } catch (err) {
    problems.push(errMessage(err))
  }

  const rails = resolveProMaxVerificationRails(ports.repoRoot)
  const testFiles = rails.reduce((total, r) => total + r.resolvedTestFiles.length, 0)
  ports.log(`[promax] rails: ${rails.length} declared, ${testFiles} test file(s) selected`)
  try {
    assertRailSelectionsNonEmpty(rails)
  } catch (err) {
    problems.push(errMessage(err))
  }

  const record = loadRecord(ports, flag(argv, "record"))
  if (!record.ok) problems.push(record.message)
  else {
    ports.log(
      `[promax] frozen campaign: ${record.record.campaign_id} sha256=${record.record.sha256} ` +
        `quanta=${record.record.quanta.sha} samples=${record.record.samples
          .map((s) => `${s.name}:${s.instanceIds.length}`)
          .join(" ")}`,
    )
  }

  if (problems.length === 0) {
    ports.log("[promax] PREFLIGHT OK — the hermetic preconditions for live spend are satisfied.")
    return 0
  }
  for (const problem of problems) ports.log(`[promax] REFUSED — ${problem}`)
  return 1
}

/** Freeze a campaign from operator-declared inputs, with live source attestations. */
const runFreeze = (argv: readonly string[], ports: CampaignCliPorts): number => {
  const inputPath = flag(argv, "input")
  const out = flag(argv, "out")
  if (inputPath === undefined || out === undefined) {
    ports.log(
      "[promax] REFUSED — freeze requires --input <campaign-input.json> and --out <campaign-record.json>.",
    )
    return 1
  }
  if (ports.sourceSnapshot === undefined) {
    ports.log(
      "[promax] REFUSED — this caller cannot attest the current repository SHA and cleanliness.",
    )
    return 1
  }
  const doc = readJson(ports, inputPath, "campaign input")
  if (!doc.ok) {
    ports.log(`[promax] REFUSED — ${doc.message}`)
    return 1
  }
  let before: { readonly sha: string; readonly dirty: boolean }
  try {
    before = ports.sourceSnapshot()
  } catch (err) {
    ports.log(`[promax] REFUSED — repository snapshot could not be read (${errMessage(err)}).`)
    return 1
  }
  if (before.dirty) {
    ports.log(
      "[promax] REFUSED — repository tree is dirty; a dirty overlay cannot freeze a campaign.",
    )
    return 1
  }
  const audit = auditProMaxSourceOwners(collectOwnerAuditSources(ports.repoRoot))
  let frozen: ProMaxCampaignRecordResult
  try {
    frozen = freezeProMaxCampaignRecord({
      ...(doc.value as FreezeProMaxCampaignInput),
      quanta: before,
      ownerAudit: audit,
    })
  } catch (err) {
    ports.log(
      `[promax] REFUSED — campaign input is not a usable freeze declaration (${errMessage(err)}).`,
    )
    return 1
  }
  if (!frozen.ok) {
    ports.log(
      `[promax] REFUSED — ${frozen.failures.map((f) => `${f.code}: ${f.message}`).join(" | ")}`,
    )
    return 1
  }
  let after: { readonly sha: string; readonly dirty: boolean }
  try {
    after = ports.sourceSnapshot()
  } catch (err) {
    ports.log(`[promax] REFUSED — repository snapshot could not be re-read (${errMessage(err)}).`)
    return 1
  }
  if (after.dirty || after.sha !== before.sha) {
    ports.log(
      `[promax] REFUSED — repository changed while freezing (before=${before.sha} dirty=${before.dirty}, ` +
        `after=${after.sha} dirty=${after.dirty}); no record was written.`,
    )
    return 1
  }
  ports.writeFile(out, serializeProMaxCampaignRecord(frozen.record))
  ports.log(
    `[promax] FROZEN — ${frozen.record.campaign_id} sha256=${frozen.record.sha256} quanta=${before.sha}`,
  )
  return 0
}

const decodeExceptions = (
  ports: CampaignCliPorts,
  path: string | undefined,
):
  | { readonly ok: true; readonly manifest?: ProMaxExceptionManifest }
  | { readonly ok: false; readonly message: string } => {
  if (path === undefined) return { ok: true }
  const doc = readJson(ports, path, "upstream-exception manifest")
  if (!doc.ok) return { ok: false, message: doc.message }
  return { ok: true, manifest: doc.value as ProMaxExceptionManifest }
}

type GateEvaluation =
  | { readonly ok: true; readonly result: ProMaxGateResult }
  | { readonly ok: false; readonly problems: readonly string[] }

/** Gate 4 needs TWO arms; either one being unusable refuses the pair. */
const evaluatePairedGate = (
  record: ProMaxFrozenCampaignRecord,
  evidenceDoc: unknown,
): GateEvaluation => {
  const raw = evidenceDoc as { readonly control?: unknown; readonly candidate?: unknown }
  const control = decodeProMaxArmEvidence(raw.control)
  const candidate = decodeProMaxArmEvidence(raw.candidate)
  if (!control.ok || !candidate.ok) {
    return {
      ok: false,
      problems: [
        ...(control.ok ? [] : control.problems),
        ...(candidate.ok ? [] : candidate.problems),
      ],
    }
  }
  return {
    ok: true,
    result: evaluateProMaxPairedGate({
      record,
      control: control.evidence,
      candidate: candidate.evidence,
    }),
  }
}

/** Gate 6 is the only gate that reads OTHER gates' written result receipts. */
const evaluateFullRunGate = (
  argv: readonly string[],
  ports: CampaignCliPorts,
  record: ProMaxFrozenCampaignRecord,
  evidenceDoc: unknown,
): GateEvaluation => {
  const decoded = decodeProMaxModelStageEvidence(evidenceDoc)
  if (!decoded.ok) return { ok: false, problems: decoded.problems }
  const priorPath = flag(argv, "prior")
  const priorDoc =
    priorPath === undefined
      ? { ok: true as const, value: [] }
      : readJson(ports, priorPath, "prior gate results")
  if (!priorDoc.ok) return { ok: false, problems: [priorDoc.message] }
  const priors = decodeProMaxGateResults(priorDoc.value)
  if (!priors.ok) return { ok: false, problems: priors.problems }
  const chunks = decodeProMaxChunks((evidenceDoc as { readonly chunks?: unknown }).chunks ?? [])
  if (!chunks.ok) return { ok: false, problems: chunks.problems }
  return {
    ok: true,
    result: admitProMaxFullRun({
      record,
      priorGates: priors.evidence,
      evidence: decoded.evidence,
      chunks: chunks.evidence,
    }),
  }
}

const evaluateGate = (
  gate: ProMaxGateId,
  argv: readonly string[],
  ports: CampaignCliPorts,
  record: ProMaxFrozenCampaignRecord,
  evidenceDoc: unknown,
):
  | { readonly ok: true; readonly result: ProMaxGateResult }
  | { readonly ok: false; readonly problems: readonly string[] } => {
  if (gate === "gate1_pmx7_gold" || gate === "gate5_pmx170_gold") {
    const decoded = decodeProMaxStageEvidence(evidenceDoc)
    if (!decoded.ok) return { ok: false, problems: decoded.problems }
    const exceptions = decodeExceptions(ports, flag(argv, "exceptions"))
    if (!exceptions.ok) return { ok: false, problems: [exceptions.message] }
    return {
      ok: true,
      result: evaluateProMaxGoldGate({
        record,
        sampleName: PROMAX_GATE_SAMPLE[gate],
        evidence: decoded.evidence,
        ...(exceptions.manifest !== undefined ? { exceptions: exceptions.manifest } : {}),
      }),
    }
  }

  if (gate === "gate4_pmx40_paired") return evaluatePairedGate(record, evidenceDoc)

  const decoded = decodeProMaxModelStageEvidence(evidenceDoc)
  if (!decoded.ok) return { ok: false, problems: decoded.problems }
  if (gate === "gate2_pmx7_model") {
    return {
      ok: true,
      result: evaluateProMaxModelSmokeGate({
        record,
        sampleName: PROMAX_GATE_SAMPLE[gate],
        evidence: decoded.evidence,
      }),
    }
  }
  if (gate === "gate3_pmx14_canary") {
    return { ok: true, result: evaluateProMaxCanaryGate({ record, evidence: decoded.evidence }) }
  }

  return evaluateFullRunGate(argv, ports, record, evidenceDoc)
}

/**
 * Print the operator-facing verdict for one evaluated gate: the headline, the
 * continuation arithmetic when the gate produced any, then every failure.
 *
 * A unit because this is the whole of what a human reads off a gate run, and the three
 * parts are one message in a fixed order — the headline names the sample the numbers
 * below it belong to, so emitting failures from somewhere else would strand them from
 * the gate that produced them.
 */
const reportGateResult = (
  ports: CampaignCliPorts,
  gate: ProMaxGateId,
  result: ProMaxGateResult,
): void => {
  const coverage = result.coverage
  const summary = result.summary
  ports.log(
    `[promax] ${gate} (${PROMAX_GATE_SAMPLE[gate]}): ${result.ok ? "PASS" : "REFUSED"} ` +
      (summary === null
        ? ""
        : `assigned=${summary.assigned} grading_valid=${summary.gradingValid} resolved=${summary.resolved} ` +
          `model_miss=${summary.modelMiss} infra_invalid=${summary.infraInvalid} ambiguous=${summary.ambiguous} ` +
          `missing=${summary.missing}`) +
      (coverage === undefined
        ? ""
        : ` | coverage: assigned=${coverage.assigned} valid=${coverage.valid} exceptions=${coverage.exceptions}`),
  )
  if (result.continuation !== undefined) {
    const c = result.continuation
    ports.log(
      `[promax] continuation: paired=${c.pairedInstances} resolved_delta=${c.resolvedDelta} ` +
        `cost_delta=${c.costUsdDelta} continue=${String(c.continue)}`,
    )
  }
  for (const failure of result.failures) ports.log(`[promax] ${failure.code}: ${failure.message}`)
}

/**
 * Evaluate ONE gate and report it. The result receipt is written when `--out` is
 * given, which is what lets gate 6 read gates 1-5 back as ARTEFACTS rather than
 * taking a caller's word that they passed.
 */
const runGate = (argv: readonly string[], ports: CampaignCliPorts): number => {
  const requested = flag(argv, "gate")
  if (requested === undefined || !(PROMAX_GATE_ORDER as readonly string[]).includes(requested)) {
    ports.log(
      `[promax] REFUSED — unknown gate "${String(requested)}". The staged gates are: ` +
        `${PROMAX_GATE_ORDER.join(", ")}. REFUSING to fall back to a cheaper gate.`,
    )
    return 1
  }
  const gate = requested as ProMaxGateId

  const record = loadRecord(ports, flag(argv, "record"))
  if (!record.ok) {
    ports.log(`[promax] REFUSED — ${record.message}`)
    return 1
  }
  const evidencePath = flag(argv, "evidence")
  if (evidencePath === undefined) {
    ports.log("[promax] REFUSED — --evidence <path> is required to evaluate a gate.")
    return 1
  }
  const evidenceDoc = readJson(ports, evidencePath, "gate evidence")
  if (!evidenceDoc.ok) {
    ports.log(`[promax] REFUSED — ${evidenceDoc.message}`)
    return 1
  }

  const evaluated = evaluateGate(gate, argv, ports, record.record, evidenceDoc.value)
  if (!evaluated.ok) {
    ports.log(`[promax] REFUSED — ${gate} evidence is unusable: ${evaluated.problems.join(" | ")}`)
    return 1
  }
  const { result } = evaluated
  reportGateResult(ports, gate, result)

  const out = flag(argv, "out")
  if (out !== undefined) {
    ports.writeFile(
      out,
      `${JSON.stringify(
        {
          gate: result.gate,
          ok: result.ok,
          failures: result.failures,
          summary: result.summary,
          ...(result.coverage !== undefined ? { coverage: result.coverage } : {}),
          ...(result.continuation !== undefined ? { continuation: result.continuation } : {}),
        },
        null,
        2,
      )}\n`,
    )
  }
  return result.ok ? 0 : 1
}

export const PROMAX_CAMPAIGN_CLI_USAGE = [
  "quanta promax-campaign freeze --input <campaign-input.json> --out <campaign-record.json>",
  "quanta promax-campaign preflight --record <campaign-record.json>",
  "quanta promax-campaign gate --gate <id> --record <path> --evidence <path>",
  "                              [--exceptions <path>] [--prior <path>] [--out <path>]",
  `  gates: ${PROMAX_GATE_ORDER.join(", ")}`,
].join("\n")

/** The command. Returns the process exit code; never throws for a refusal. */
export const runProMaxCampaignCli = (argv: readonly string[], ports: CampaignCliPorts): number => {
  const subcommand = argv[0]
  if (subcommand === "freeze") return runFreeze(argv, ports)
  if (subcommand === "preflight") return runPreflight(argv, ports)
  if (subcommand === "gate") return runGate(argv, ports)
  ports.log(PROMAX_CAMPAIGN_CLI_USAGE)
  return 1
}
