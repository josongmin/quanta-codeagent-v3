/**
 * LEAF — a GENERIC process-boundary helper: bring a receipt document back from a
 * box and hand it to its OWNER's parser.
 *
 * ## The owner split this file exists to make structural
 *
 * PMX-04: *"This preflight is implemented once by the harness image-lifecycle
 * owner and is used by gold and model runs. Remote code persists/transports the
 * returned receipt; it does not reproduce the checks with shell-output
 * heuristics."*
 *
 * The temptation this closes is concrete. Remote already runs commands over ssh
 * and already sees their stdout/stderr, so "is the image ok?" looks like one
 * `grep` away — and that grep would be a SECOND classifier, drifting from the
 * harness table the report and dashboard consume. So this module has exactly one
 * capability: read BYTES from a path on the box and pass them to
 * {@link parseProMaxImageFreezeReceipt}. It cannot construct a fault, because a
 * fault code it invented is refused by that parser.
 *
 * The fetch is INJECTED, so the box boundary is a function in a test and an ssh
 * `cat` in production. Nothing here shells out on its own.
 */
import {
  type ProMaxImageFreezeReceipt,
  type ProMaxImageReceiptFailure,
  parseProMaxImageFreezeReceipt,
} from "@/apps/bench/harness/promax"

/** Read a file's text off the box. The ONLY process boundary this module has. */
export type OnBoxTextFetch = (
  remotePath: string,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>

/**
 * Two distinct negative outcomes, deliberately not merged: a box that could not
 * be read from is an operator/infra problem, while a document that was read but
 * refused is a CAMPAIGN problem. Collapsing them is how "the run produced no
 * verdicts" gets misfiled as "the images were bad".
 */
export type ReceiptTransportOutcome =
  | { readonly ok: true; readonly receipt: ProMaxImageFreezeReceipt }
  | { readonly ok: false; readonly code: "transport_failed"; readonly message: string }
  | {
      readonly ok: false
      readonly code: "receipt_rejected"
      readonly failures: readonly ProMaxImageReceiptFailure[]
    }

export const receiveProMaxImageReceipt = async (args: {
  readonly fetch: OnBoxTextFetch
  readonly remotePath: string
}): Promise<ReceiptTransportOutcome> => {
  const read = await args.fetch(args.remotePath)
  if (read.code !== 0) {
    return {
      ok: false,
      code: "transport_failed",
      message:
        `could not read the ProMax image-freeze receipt from ${args.remotePath} ` +
        `(exit ${read.code}): ${read.stderr.trim() || "(no stderr)"}`,
    }
  }
  const parsed = parseProMaxImageFreezeReceipt(read.stdout)
  if (!parsed.ok) return { ok: false, code: "receipt_rejected", failures: parsed.failures }
  return { ok: true, receipt: parsed.receipt }
}
