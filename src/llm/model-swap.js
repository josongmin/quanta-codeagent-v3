import { QuantaError } from "@/shared";
/** Raised when no DISTINCT alternate model can be selected for a swap retry —
 *  either the requested id is absent, or `current` is already the last entry
 *  in the ordered escalation list (wrapping is NOT allowed). */
export class NoAlternateModelError extends QuantaError {
    constructor(message) {
        super("no_alternate_model", message);
    }
}
/**
 * Pure ordered-list selection: return the id immediately AFTER `current` in
 * `orderedIds`, or `null` if `current` is the last entry or absent (wrapping is
 * NOT allowed). Mirrors v0's `getEnabledModelFallback` next-in-list semantics.
 */
export const pickNextModel = (current, orderedIds) => {
    const idx = orderedIds.indexOf(current);
    if (idx === -1)
        return null;
    const next = orderedIds[idx + 1];
    return next ?? null;
};
/**
 * Resolve which candidate to re-run a turn against.
 *
 *  - If `requested` is given, pick the candidate with that exact id (it must be
 *    present and DISTINCT from `current`); otherwise throw.
 *  - Otherwise escalate: pick the NEXT candidate after `current` in the ordered
 *    list. Wrapping is NOT allowed — if `current` is the last (or absent), there
 *    is no alternate and we throw.
 *
 * Throws {@link NoAlternateModelError} when no distinct alternate exists.
 */
export const resolveRetryModel = (args) => {
    const { current, candidates, requested } = args;
    if (requested !== undefined) {
        if (requested === current) {
            throw new NoAlternateModelError(`requested model "${requested}" is the same as the current model; a swap retry must change models`);
        }
        const match = candidates.find((c) => c.id === requested);
        if (match === undefined) {
            throw new NoAlternateModelError(`requested model "${requested}" is not an enabled candidate`);
        }
        return match;
    }
    // Escalation: next distinct candidate after `current`.
    const orderedIds = candidates.map((c) => c.id);
    const nextId = pickNextModel(current, orderedIds);
    if (nextId === null) {
        throw new NoAlternateModelError(`no alternate model after "${current}" in the candidate list (wrapping is not allowed)`);
    }
    const next = candidates.find((c) => c.id === nextId);
    if (next === undefined) {
        // Unreachable: nextId came from orderedIds which maps candidates 1:1.
        throw new NoAlternateModelError(`alternate model "${nextId}" has no candidate port`);
    }
    return next;
};
/**
 * Stream a turn from the chosen candidate's port, prefixed with a single
 * `stream_reset` tombstone. The leading `stream_reset` reuses the semantics
 * documented on {@link StreamEvent} (src/llm/types.ts): any consumer that had
 * accumulated the PRIOR assistant message (the one being replaced) MUST discard
 * it and assemble fresh from this stream. The tombstone is emitted exactly once,
 * before any inner event.
 */
export async function* streamWithModel(candidate, input) {
    yield { type: "stream_reset" };
    for await (const ev of candidate.port.stream(input)) {
        yield ev;
    }
}
