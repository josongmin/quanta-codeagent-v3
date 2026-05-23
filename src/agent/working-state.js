/**
 * WorkingState — Codex memory layer L3 (Codex `memory-model-audit.md` mirror).
 *
 * Per-turn, free-form scratchpad the LLM updates as it works: the current owner
 * shortlist, a working hypothesis, blockers, deferred validations, and the
 * next-step queue. The loop carries it across turns when the caller opts in via
 * `AgentConfig.workingState = { enabled: true }`; absent ⇒ no block is rendered
 * and the loop is byte-identical (default-OFF).
 *
 * Codex's key insight: this is L3, NOT durable storage. Durable state still
 * externalizes to artifacts (workspace files). WorkingState is the in-session
 * scratch that gives the agent a place to PLAN AHEAD without bloating chat.
 */
export const emptyWorkingState = () => ({
    ownerShortlist: [],
    blockers: [],
    nextStepQueue: [],
    deferredValidation: [],
});
/** True when EVERY field is empty (no owners, no hypothesis, no blockers, no
 *  next steps, no deferred validation). Used to skip the per-turn block when
 *  there is nothing to carry — keeps the reminder uncluttered. */
const isEmpty = (s) => s.ownerShortlist.length === 0 &&
    (s.hypothesis === undefined || s.hypothesis.trim() === "") &&
    s.blockers.length === 0 &&
    s.nextStepQueue.length === 0 &&
    s.deferredValidation.length === 0;
/** Build a fresh session-scoped WorkingState handle. State starts empty; the
 *  LLM populates it via the `update_working_state` meta-tool. */
export const createWorkingStateSession = () => {
    let state = emptyWorkingState();
    return {
        mutate(patch) {
            const next = { ...state };
            if (patch.ownerShortlist !== undefined)
                next.ownerShortlist = [...patch.ownerShortlist];
            if (patch.hypothesis !== undefined) {
                if (patch.hypothesis === null)
                    delete next.hypothesis;
                else
                    next.hypothesis = patch.hypothesis;
            }
            if (patch.blockers !== undefined)
                next.blockers = [...patch.blockers];
            if (patch.nextStepQueue !== undefined)
                next.nextStepQueue = [...patch.nextStepQueue];
            if (patch.deferredValidation !== undefined) {
                next.deferredValidation = [...patch.deferredValidation];
            }
            state = next;
            return state;
        },
        snapshot() {
            // Deep-copy: caller-visible "snapshot" must NOT alias live state, or
            // a subsequent `mutate(...)` (e.g. from a concurrent tool call earlier
            // in the same turn) would race a reader holding the snapshot. Inner
            // arrays carry caller-supplied object references — clone the entries
            // too so accidental `snap.blockers[0].what = "..."` cannot tamper with
            // session state. `mutate(patch)` itself is replacement-only so this is
            // the only seam where a live reference could escape.
            return {
                ownerShortlist: state.ownerShortlist.map((o) => ({ ...o })),
                blockers: state.blockers.map((b) => ({ ...b })),
                nextStepQueue: state.nextStepQueue.map((n) => ({ ...n })),
                deferredValidation: state.deferredValidation.map((d) => ({ ...d })),
                ...(state.hypothesis !== undefined ? { hypothesis: state.hypothesis } : {}),
            };
        },
    };
};
/** Render a non-empty list under a sub-header (e.g. "### Owner shortlist") via
 *  the provided item renderer. Returns `[]` when the list is empty so the
 *  caller's accumulator stays compact. Extracted to keep the public
 *  `renderWorkingStateBlock` under the project's cognitive-complexity budget. */
const renderSection = (header, items, fmt) => (items.length === 0 ? [] : ["", header, ...items.map(fmt)]);
/** Render the hypothesis section, if any. */
const renderHypothesis = (hypothesis) => {
    if (hypothesis === undefined || hypothesis.trim() === "")
        return [];
    return ["", "### Hypothesis", hypothesis.trim()];
};
/** Render a WorkingState as a compact markdown block for the per-turn reminder.
 *  Returns `undefined` when the state is empty (no clutter when there is
 *  nothing to carry). Sub-headers are emitted only for non-empty fields so the
 *  block stays as small as possible. */
export const renderWorkingStateBlock = (state) => {
    if (isEmpty(state))
        return undefined;
    const lines = ["## Working state"];
    lines.push(...renderSection("### Owner shortlist", state.ownerShortlist, (o) => `- ${o.file} — ${o.reason}`), ...renderHypothesis(state.hypothesis), ...renderSection("### Blockers", state.blockers, (b) => `- [${b.surface}] ${b.what}`), ...renderSection("### Next steps", state.nextStepQueue, (n) => `- ${n.what}${n.deferred ? " (deferred)" : ""}`), ...renderSection("### Deferred validation", state.deferredValidation, (d) => `- ${d.rail}: ${d.reason}`));
    return lines.join("\n");
};
