/** Closed enumeration of {@link SubmissionOp} discriminants. Adding a new
 *  variant to the union MUST also extend this array — the matching
 *  `submission-set-mode-hell.test.ts` exhaustive-coverage assertion fails CI
 *  otherwise. Mirrors `RESPONSE_QUEUED_REASONS` / `ALL_PAUSED_REASONS` in
 *  shape. Frozen so accidental mutation by a consumer is a hard error. */
export const ALL_SUBMISSION_OP_KINDS = Object.freeze([
    "user_input",
    "user_input_with_turn_context",
    "interrupt",
    "cancel_subagent",
    "shutdown",
    "reload_user_config",
    "set_mode",
]);
/** Submission ids the adapter synthesizes carry this prefix so a trajectory
 *  audit can distinguish them from real host-issued ids. Synthesized only
 *  when {@link submissionFromMessages} runs the adapter for a legacy caller
 *  who never minted one. */
export const SUBMISSION_LEGACY_ID_PREFIX = "legacy-";
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
export const submissionFromMessages = (messages, trace, opts = {}) => {
    if (messages.length === 0)
        return undefined;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user")
        return undefined;
    const uuidFn = opts.uuid ??
        (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? () => crypto.randomUUID()
            : undefined);
    const nowFn = opts.now ?? Date.now;
    const id = uuidFn
        ? `${SUBMISSION_LEGACY_ID_PREFIX}${uuidFn()}`
        : `${SUBMISSION_LEGACY_ID_PREFIX}${nowFn().toString(36)}`;
    const op = { kind: "user_input", items: last.content };
    return trace !== undefined ? { id, op, trace } : { id, op };
};
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
export const extractSeedMessages = (sub) => {
    if (sub.op.kind === "user_input" || sub.op.kind === "user_input_with_turn_context") {
        return [{ role: "user", content: sub.op.items }];
    }
    return undefined;
};
/** Type guard: this submission is a "new user turn" shape the seed loop
 *  consumes. Other variants are accepted but not yet wired (see module doc). */
export const isUserInputSubmission = (sub) => sub.op.kind === "user_input" || sub.op.kind === "user_input_with_turn_context";
