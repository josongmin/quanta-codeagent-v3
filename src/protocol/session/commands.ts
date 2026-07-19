import type { ImageBlock, Message } from "@/llm/types"

export interface SessionCommandEnvelope<TType extends string> {
  readonly sessionId: string
  readonly commandId: string
  readonly issuedAt: string
  readonly expectedRevision?: number
  readonly type: TType
}

export interface InputAppendCommand extends SessionCommandEnvelope<"input.append"> {
  readonly text: string
  readonly images?: readonly ImageBlock[]
}

export interface TurnRunCommand extends SessionCommandEnvelope<"turn.run"> {
  /**
   * B-MED-7 (multi-peer 승인 입양 정확화) — ADDITIVE, optional. When a
   * `turn.run` is the daemon-owned POST-APPROVAL CONTINUATION (ADR-0540 W1-B,
   * `serverAutoContinues`), the daemon stamps the ORIGINATING `approvalId` here
   * so a marker-aware wire client can adopt EXACTLY that continuation's
   * `turn.started` — instead of guessing "the next unclaimed turn.started",
   * which in a 3-peer interleave could adopt a FOREIGN peer's turn.
   *
   * The daemon ALSO mints this continuation's `commandId` deterministically as
   * {@link continuationCommandIdForApproval}`(approvalId)` so the client can
   * PREDICT it from the `approval.resolved` event alone (the client never sees
   * the daemon's outbound command; the kernel echoes only `commandId` onto the
   * `turn.started`). This field is thus provenance/legibility + codec
   * passthrough; the correlator's match keys on the derived `commandId`.
   *
   * ABSENT ⇒ a legacy (stamp-less) auto-continue server ⇒ the client keeps the
   * historical "next unclaimed turn.started" adoption (byte-identical). A
   * pre-B-MED-7 client ignores this field entirely.
   */
  readonly causedByApprovalId?: string
}

export interface TurnCancelCommand extends SessionCommandEnvelope<"turn.cancel"> {}

export interface SessionIdentitySetCommand extends SessionCommandEnvelope<"session.identity.set"> {
  readonly mode: string
}

export interface SessionToolProfileSetCommand
  extends SessionCommandEnvelope<"session.tool_profile.set"> {
  readonly profile: string
}

/** Switch the session PERMISSION mode mid-session (default / acceptEdits /
 *  bypass / auto). Honored LIVE by the next turn's gate when the host wired a
 *  getter/setter `permission.mode` (web daemon / bootstrap). */
export interface SessionPermissionSetCommand
  extends SessionCommandEnvelope<"session.permission.set"> {
  readonly mode: string
}

export interface SessionTranscriptReplaceCommand
  extends SessionCommandEnvelope<"session.transcript.replace"> {
  readonly messages: readonly Message[]
}

export interface ApprovalRespondCommand extends SessionCommandEnvelope<"approval.respond"> {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
  /** ADR-0512 P3 — once-vs-session scope for an `approve` of a skill-scope
   *  ESCALATION approval: `once` ⇒ dispatch this call WITHOUT widening the skill
   *  scope (re-asked next time); `session`/absent ⇒ widen for the session. Only
   *  meaningful on an escalation approval (carries `scopeContext`); ignored on a
   *  normal approval ⇒ byte-identical. */
  /** #20 — `session_prefix`: a NORMAL approval (not an escalation) may mint a
   *  standing prefix grant ("always allow `<program> …` this session"); the host
   *  controller derives a SAFE program-token prefix (single simple command) or
   *  degrades to the exact key. Ignored on an escalation approval. */
  readonly scope?: "once" | "session" | "session_prefix"
  /** T05 (per-hunk diff accept/reject) — on an `approve` of a previewable
   *  mutation, the subset of hunk ids (`h1`, `h2`, …) the operator accepted; the
   *  intended apply consumer is `@/runner/hunk-apply` (partial apply, atomic +
   *  mode-preserving + staleness-guarded). ABSENT ⇒ whole-call approve, byte-
   *  identical to the pre-T05 behavior.
   *
   *  WIRING STATUS (jun-15, LANDED both surfaces): the CLI inline-confirm surface
   *  applies per-hunk directly via the executor; the web/SDK out-of-band path
   *  routes THIS field through `scheduler → host.resolveApproval` to the runtime
   *  controller, which (gate `QUANTA_HUNK_APPROVAL` ON) applies the subset against
   *  the REQUEST-time baseline it captured at mint (drift ⇒ stale, no write) and
   *  mints a `deny_and_steer` lease so the whole-call tool does NOT also re-run.
   *  A subset covering EVERY hunk / a non-previewable action / gate-off ⇒ whole-
   *  call grant, byte-identical. Ignored on a `deny`. */
  readonly selectedHunks?: readonly string[]
  /** ADR-0512 P3 — corrective steer for a `deny` of a skill-scope ESCALATION
   *  (the `deny_and_steer` verb): a non-empty message telling the model what to
   *  do instead. Absent ⇒ a plain decline. Ignored on a normal approval. */
  readonly steer?: string
}

export type SessionCommand =
  | InputAppendCommand
  | TurnRunCommand
  | TurnCancelCommand
  | SessionIdentitySetCommand
  | SessionTranscriptReplaceCommand
  | SessionToolProfileSetCommand
  | SessionPermissionSetCommand
  | ApprovalRespondCommand

export const SESSION_COMMAND_TYPES = [
  "approval.respond",
  "input.append",
  "session.identity.set",
  "session.permission.set",
  "session.transcript.replace",
  "session.tool_profile.set",
  "turn.cancel",
  "turn.run",
] as const

export type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[number]

export const isSessionCommandType = (value: unknown): value is SessionCommandType =>
  typeof value === "string" && (SESSION_COMMAND_TYPES as readonly string[]).includes(value)
