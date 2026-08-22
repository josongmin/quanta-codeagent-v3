/**
 * Adversarial multi-voter core (ADR-0433). Runs N voters in PARALLEL, parses
 * each into a typed `Verdict` (fail-closed on garbage), and aggregates by
 * quorum. Pure w.r.t. routing/scoring — the only IO is the injected
 * `LLMPort.stream` per voter and the injected clock.
 *
 * Refute bias (negative invariant): a voter that emits unparseable output, or
 * THROWS, is counted as a REFUTE (`pass:false`). A tie at the quorum boundary
 * fails-closed. This makes the aggregate conservative — it passes ONLY when a
 * genuine quorum of voters affirmatively passes the claim.
 */

import type { LLMPort, StreamEvent } from "@/llm"
import { assembleFromEvents } from "@/llm"
import { errMessage } from "@/shared"
import type { MultiVoterRequest, Verdict, VoteOutcome, VoteRecord, Voter } from "./types"

/** Strict-majority default: a claim passes IFF MORE than half the voters pass. */
export const DEFAULT_QUORUM = 0.5

const clampUnit = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

/** The system prompt that turns an `LLMPort` into an adversarial refuter. The
 *  voter is told to DEFAULT TO FAIL under uncertainty and to answer ONLY with
 *  a single JSON object so the parse is deterministic. */
export const buildRefutePrompt = (claim: string, lens?: string): string => {
  const lensLine = lens ? `Adopt the lens of a skeptical ${lens} reviewer. ` : ""
  return [
    `You are an ADVERSARIAL verifier. ${lensLine}Your job is to REFUTE the following claim, not to agree with it.`,
    `Default to FAILURE under any uncertainty — only pass if you are positively convinced the claim holds.`,
    "",
    `CLAIM:\n${claim}`,
    "",
    `Respond with ONE JSON object and nothing else:`,
    `{"pass": <true|false>, "confidence": <0..1>, "reason": "<short>"}`,
  ].join("\n")
}

/** Collect the assistant's text from one voter turn. */
const drainText = async (port: LLMPort, claim: string, lens?: string): Promise<string> => {
  const events: StreamEvent[] = []
  const it = port.stream({
    messages: [{ role: "user", content: [{ type: "text", text: buildRefutePrompt(claim, lens) }] }],
    tools: [],
  })
  for await (const ev of it) events.push(ev)
  const assembled = assembleFromEvents(events)
  return assembled.message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
}

/** Parse a voter's raw text into a `Verdict`. Returns `undefined` when the
 *  text contains no parseable JSON verdict — the caller fail-closes. */
export const parseVerdict = (raw: string): Verdict | undefined => {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (obj === null || typeof obj !== "object") return undefined
  const rec = obj as Record<string, unknown>
  if (typeof rec.pass !== "boolean") return undefined
  return {
    pass: rec.pass,
    confidence: clampUnit(typeof rec.confidence === "number" ? rec.confidence : 0),
    reason: typeof rec.reason === "string" ? rec.reason : "",
  }
}

/** The fail-closed verdict used when a voter throws or emits garbage. */
const refuteVerdict = (reason: string): Verdict => ({ pass: false, confidence: 0, reason })

/** Run ONE voter to a `VoteRecord`. Never throws — a thrown stream becomes a
 *  `source:"threw"` refute so the aggregate loop survives a flaky provider. */
const runVoter = async (voter: Voter, claim: string, now: () => number): Promise<VoteRecord> => {
  const t0 = now()
  try {
    const raw = await drainText(voter.port, claim, voter.lens)
    const parsed = parseVerdict(raw)
    if (parsed === undefined) {
      return {
        voterId: voter.id,
        verdict: refuteVerdict("unparseable voter output (fail-closed)"),
        source: "unparseable",
        durationMs: Math.max(0, now() - t0),
      }
    }
    return {
      voterId: voter.id,
      verdict: parsed,
      source: "parsed",
      durationMs: Math.max(0, now() - t0),
    }
  } catch (e) {
    return {
      voterId: voter.id,
      verdict: refuteVerdict(`voter threw: ${errMessage(e)}`),
      source: "threw",
      durationMs: Math.max(0, now() - t0),
    }
  }
}

/**
 * Run all voters in PARALLEL and aggregate by quorum. The aggregate PASSES IFF
 * `passVotes / totalVotes >= quorum` AND `passVotes > totalVotes - passVotes`
 * is NOT required — the quorum alone decides, but the DEFAULT quorum (`> 0.5`
 * is encoded as `passFraction > DEFAULT_QUORUM`) means an exact tie FAILS.
 *
 * Concretely the rule is: with the default quorum (0.5) the comparison is a
 * STRICT majority (`passVotes * 2 > totalVotes`); with an explicit quorum `q`
 * the comparison is `passVotes / totalVotes >= q`. A 1-of-2 tie therefore
 * fails by default (refute bias), and 0 voters fails-closed.
 */
export const runMultiVoter = async (req: MultiVoterRequest): Promise<VoteOutcome> => {
  const now = req.now ?? Date.now
  const votes = await Promise.all(req.voters.map((v) => runVoter(v, req.claim, now)))
  const totalVotes = votes.length
  const passVotes = votes.filter((v) => v.verdict.pass).length
  // ABSENT quorum ⇒ strict-majority default (a tie fails-closed). An EXPLICIT
  // quorum — including `0.5` — uses the `>=` fraction comparison, so a caller
  // who deliberately sets `0.5` opts into "half or more passes". The
  // distinction is presence, NOT value, so an explicit `0.5` is honoured.
  const quorumMet =
    req.quorum === undefined
      ? quorumPasses(passVotes, totalVotes, DEFAULT_QUORUM)
      : explicitQuorumPasses(passVotes, totalVotes, req.quorum)
  return { verdict: quorumMet, votes, passVotes, totalVotes, quorumMet }
}

/** Quorum predicate. With the strict-majority sentinel `DEFAULT_QUORUM`
 *  (`0.5`) requires a STRICT majority so a tie fails-closed; with ANY OTHER
 *  `q` requires `passVotes / totalVotes >= q`. Zero voters always fails.
 *
 *  NOTE: `runMultiVoter` distinguishes an ABSENT quorum (⇒ strict majority via
 *  this sentinel) from an EXPLICIT `0.5` (⇒ `>=` fraction). Callers invoking
 *  `quorumPasses` directly with `0.5` get the strict-majority reading. */
export const quorumPasses = (passVotes: number, totalVotes: number, quorum: number): boolean => {
  if (totalVotes <= 0) return false
  if (quorum === DEFAULT_QUORUM) return passVotes * 2 > totalVotes
  return passVotes / totalVotes >= quorum
}

/** Explicit-quorum predicate — ALWAYS the `>=` fraction comparison, even for
 *  `0.5` (which `quorumPasses` would otherwise read as the strict-majority
 *  sentinel). Used by `runMultiVoter` when the caller passes a quorum. */
export const explicitQuorumPasses = (
  passVotes: number,
  totalVotes: number,
  quorum: number,
): boolean => {
  if (totalVotes <= 0) return false
  return passVotes / totalVotes >= quorum
}
