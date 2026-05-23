/**
 * Submission op enum — Codex `Submission`/`Op` envelope absorption (Spec A3).
 *
 * Codex models every host→agent input as a typed `Submission { id; op; ... }`
 * whose `op` discriminates user input, mid-turn interrupt, subagent cancel,
 * runtime shutdown, and config reload. v3's `runAgent` historically accepted
 * only an untyped `messages: Message[]` seed, so the legacy entry has no place
 * to express "this is an interrupt" or "this is a cancel" without inventing
 * out-of-band signaling.
 *
 * This module defines the typed envelope WITHOUT rewiring the loop:
 *
 *   - {@link SubmissionOp} — 6-variant discriminated union (user_input,
 *     user_input_with_turn_context, interrupt, cancel_subagent, shutdown,
 *     reload_user_config). The first two are the only ones the seed loop
 *     consumes today; the others are accepted-and-ignored shapes so a surface
 *     can already round-trip them, and future absorption rounds can wire them
 *     without breaking the type.
 *   - {@link Submission} — `{ id; op; trace? }`. `trace` reuses the shipped
 *     {@link RunContext} so a host that already correlates a run does NOT
 *     duplicate the structure.
 *   - {@link submissionFromMessages} — pure adapter that lifts the legacy
 *     `messages` seed into a `user_input` Submission (`id`/`trace` derived
 *     from the run context when present, synthesized otherwise).
 *   - {@link extractSeedMessages} — pure projection that pulls back a seed
 *     `Message[]` from a Submission's `user_input` shape so the loop can
 *     keep its single in-process buffer model (no second seam).
 *
 * Default-OFF byte-identical (RFC §1.2): the loop's existing `messages` path
 * is untouched. A caller that passes `submission` instead gets the EXACT same
 * seed semantics — the adapter is pure and round-trips:
 *   `extractSeedMessages(submissionFromMessages(m)) ≡ m` (reference equality
 *   on the seed list, see unit tests).
 */
import type { ContentBlock, Message } from "@/llm"
import type { RunContext } from "@/shared"
import type { TurnContextInput } from "./prompt"

/**
 * Discriminated union of envelope ops a host can submit to the agent.
 *
 * Today the loop consumes ONLY `user_input` / `user_input_with_turn_context`.
 * The other variants are shape-only (no behavior wired) so:
 *
 *   1. a surface can already encode interrupt / cancel / shutdown / reload
 *      submissions and round-trip them through any persistence layer;
 *   2. a future absorption round can wire them WITHOUT changing this type
 *      (and without changing the legacy `messages` entry point).
 *
 * Each variant is `{ kind: ...; ... }` so an exhaustive switch in a future
 * dispatcher is `kind`-only — no field-presence narrowing.
 */
export type SubmissionOp =
  /** New user turn — `items` is the user message's content blocks. */
  | { kind: "user_input"; items: ContentBlock[] }
  /** New user turn with caller-supplied per-turn context overrides. The loop
   *  still owns the canonical `TurnContextInput` (it composes recall + repo
   *  rules etc.), so this shape is forward-looking: the host can pre-stage a
   *  `TurnContextInput` it would have built anyway. */
  | {
      kind: "user_input_with_turn_context"
      items: ContentBlock[]
      turnContext: TurnContextInput
    }
  /** Cancel the in-flight turn (ADR-0030 mid-turn steering already wires
   *  AbortSignal; this is the typed envelope shape). `turnId` narrows the
   *  cancel to a specific turn — absent ⇒ "the active turn". */
  | { kind: "interrupt"; turnId?: string }
  /** Stop a running subagent by id (ADR-0011 subagent runner already exposes
   *  cancellation via its `TaskStop` tool; this is the host-side envelope). */
  | { kind: "cancel_subagent"; subagentId: string }
  /** Best-effort runtime shutdown. Surfaces use this to ask the agent to
   *  finalize the session and flush state. */
  | { kind: "shutdown" }
  /** Reload host-side user config (e.g. permissions, mode). Acknowledged
   *  as a shape but the loop does not re-read its own config mid-run. */
  | { kind: "reload_user_config" }

/**
 * Typed submission envelope.
 *
 *   - `id` — stable submission id (`crypto.randomUUID()` by adapter when
 *     synthesizing from legacy `messages`).
 *   - `op` — see {@link SubmissionOp}.
 *   - `trace` — OPTIONAL correlation context. Reuses {@link RunContext} so a
 *     host already tagging a run doesn't duplicate the structure.
 */
export interface Submission {
  id: string
  op: SubmissionOp
  trace?: RunContext
}

/** Submission ids the adapter synthesizes carry this prefix so a trajectory
 *  audit can distinguish them from real host-issued ids. Synthesized only
 *  when {@link submissionFromMessages} runs the adapter for a legacy caller
 *  who never minted one. */
export const SUBMISSION_LEGACY_ID_PREFIX = "legacy-"

/**
 * Optional injection point for the synthesized submission `id` (ADR-0078
 * determinism leak — the id is PERSISTED into the JSONL envelope and any
 * trajectory store, so a non-deterministic id breaks the byte-identical
 * replay invariant). Both fields default to the host crypto/clock; replay
 * supplies deterministic ones. Pattern: `opts.now ?? Date.now` (cf.
 * `src/agent/admissibility-gate.ts`, `src/memory/consolidate/writer.ts`).
 */
export interface SubmissionFromMessagesOpts {
  /** UUID source for the primary id path (preferred when present). Falls back
   *  to the `now`/Date.now base36 timestamp when neither `crypto.randomUUID`
   *  nor this is available. Defaults to `crypto.randomUUID`. */
  uuid?: () => string
  /** Clock source for the fallback id path. Defaults to {@link Date.now}. */
  now?: () => number
}

/**
 * Lift a legacy `messages` seed into a typed {@link Submission}.
 *
 * Contract:
 *   - `messages` MUST be a NON-empty list whose LAST element is a `user`
 *     message — this mirrors v3's runAgent invariant (the seed is "one user
 *     turn"). Earlier elements (if any, e.g. a resumed history) are dropped
 *     here because the Submission envelope models ONE turn; the loop already
 *     keeps the full history in `wm`/`AgentConfig.messages`, so no data is
 *     lost — the adapter is meant for the new-turn surface, NOT the
 *     resume-history surface.
 *   - Returns `undefined` when `messages` is empty OR the last message is
 *     not a user turn. The loop falls back to the legacy path on
 *     `undefined`, so this is a safe no-op (byte-identical).
 *   - `opts.uuid` / `opts.now` are optional injection ports for replay /
 *     unit tests; defaults yield the legacy byte-identical id shape.
 */
export const submissionFromMessages = (
  messages: Message[],
  trace?: RunContext,
  opts: SubmissionFromMessagesOpts = {},
): Submission | undefined => {
  if (messages.length === 0) return undefined
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return undefined
  const uuidFn =
    opts.uuid ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? () => crypto.randomUUID()
      : undefined)
  const nowFn = opts.now ?? Date.now
  const id = uuidFn
    ? `${SUBMISSION_LEGACY_ID_PREFIX}${uuidFn()}`
    : `${SUBMISSION_LEGACY_ID_PREFIX}${nowFn().toString(36)}`
  const op: SubmissionOp = { kind: "user_input", items: last.content }
  return trace !== undefined ? { id, op, trace } : { id, op }
}

/**
 * Project a Submission back to a seed `Message[]` for the loop's working-
 * memory constructor.
 *
 *   - `user_input` / `user_input_with_turn_context` → one user message whose
 *     content is `op.items`.
 *   - everything else → `undefined` (control-op variants don't seed history).
 *
 * Round-trip property (see unit tests): for any `messages = [user{content}]`
 * (the only shape the loop accepts as a seed),
 * `extractSeedMessages(submissionFromMessages(messages)) ≡ messages` by
 * structural equality on `content`.
 */
export const extractSeedMessages = (sub: Submission): Message[] | undefined => {
  if (sub.op.kind === "user_input" || sub.op.kind === "user_input_with_turn_context") {
    return [{ role: "user", content: sub.op.items }]
  }
  return undefined
}

/** Type guard: this submission is a "new user turn" shape the seed loop
 *  consumes. Other variants are accepted but not yet wired (see module doc). */
export const isUserInputSubmission = (
  sub: Submission,
): sub is Submission & {
  op:
    | { kind: "user_input"; items: ContentBlock[] }
    | { kind: "user_input_with_turn_context"; items: ContentBlock[]; turnContext: TurnContextInput }
} => sub.op.kind === "user_input" || sub.op.kind === "user_input_with_turn_context"
