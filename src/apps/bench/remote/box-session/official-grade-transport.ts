/**
 * LEAF — a GENERIC process-boundary helper: bring an official-grade RECEIPT back
 * from a box and hand it to the PMX-03 parser.
 *
 * ## The owner split this file makes structural
 *
 * PMX-04's rule for `remote/**` is that it owns provisioning, transport, retry
 * and coverage — *and nothing else*. In particular it must carry PMX-03's
 * generic {@link OfficialGradeReceipt} as the ONLY verdict payload, never a
 * family-specific verdict parser.
 *
 * The temptation is concrete and already exists next door: `verdict-parse.ts`
 * scrapes the swebench harness report's four id arrays out of box output. Doing
 * the same for ProMax would put a SECOND classifier on the remote side, drifting
 * from the harness table the report and the dashboard consume, and it would
 * quietly resurrect exactly the legacy four-bucket authority the ticket forbids
 * (`ambiguous` has nowhere to go in four arrays, and `missing` has nowhere to go
 * at all).
 *
 * So this module has exactly one capability: read BYTES from a path on the box
 * and pass them to {@link parseOfficialGradeReceipt}. It cannot author a
 * disposition, because a disposition it invented — an unknown state, an id
 * outside the assigned set, a second verdict for the same id — is refused by
 * that parser, fail-closed.
 *
 * The fetch is INJECTED: a function in a test, an ssh `cat` in production.
 * Nothing here shells out on its own.
 */
import {
  type OfficialGradeReceipt,
  type OfficialGradeReceiptFailure,
  parseOfficialGradeReceipt,
} from "@/runner/batch/eval/official-grade"
import { errMessage } from "@/shared"

/** Read a file's text off the box. The ONLY process boundary this module has. */
export type OnBoxTextFetch = (
  remotePath: string,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>

/**
 * Two distinct negative outcomes, deliberately not merged: a box that could not
 * be read from is an operator/infra problem, while a document that WAS read and
 * then refused is a campaign problem. Collapsing them is how "the grader never
 * ran" gets misfiled as "the grader said nothing".
 */
export type OfficialGradeTransportOutcome =
  | { readonly ok: true; readonly receipt: OfficialGradeReceipt }
  | { readonly ok: false; readonly code: "transport_failed"; readonly message: string }
  | {
      readonly ok: false
      readonly code: "receipt_rejected"
      readonly failures: readonly OfficialGradeReceiptFailure[]
    }

/** The box-side path a family's grader phase writes its receipt to by default.
 *  A family that needs another location declares it on its remote-bootstrap
 *  specification; nothing here hard-codes a family. */
export const DEFAULT_OFFICIAL_GRADE_RECEIPT_BOX_PATH = "~/official-grade-receipt.json"

const asJson = (
  text: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly why: string } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (e) {
    // The rejection below was already loud about WHAT happened; binding the fault
    // is what makes it loud about WHY. "Not a JSON document" alone cannot separate
    // a truncated fetch from a shell error the grader printed over its receipt.
    return { ok: false, why: errMessage(e) }
  }
}

export const receiveOfficialGradeReceipt = async (args: {
  readonly fetch: OnBoxTextFetch
  readonly remotePath: string
}): Promise<OfficialGradeTransportOutcome> => {
  const read = await args.fetch(args.remotePath)
  if (read.code !== 0) {
    return {
      ok: false,
      code: "transport_failed",
      message:
        `could not read the official-grade receipt from ${args.remotePath} ` +
        `(exit ${read.code}): ${read.stderr.trim() || "(no stderr)"}`,
    }
  }
  const parsedJson = asJson(read.stdout)
  if (!parsedJson.ok) {
    // Not JSON at all — a raw grader stream, a shell error, a truncated fetch.
    // Reported with the PMX-03 vocabulary so a caller has ONE thing to narrow on.
    return {
      ok: false,
      code: "receipt_rejected",
      failures: [
        {
          code: "receipt_unparseable",
          message:
            `the bytes at ${args.remotePath} are not a JSON document (${parsedJson.why}) — ` +
            "remote transport does not promote raw grader output to a verdict",
        },
      ],
    }
  }
  const parsed = parseOfficialGradeReceipt(parsedJson.value)
  if (!parsed.ok) return { ok: false, code: "receipt_rejected", failures: parsed.failures }
  return { ok: true, receipt: parsed.receipt }
}
