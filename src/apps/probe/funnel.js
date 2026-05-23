const STAGE_TOOLS = Object.freeze({
    // Stage 1 — FILE (candidate files)
    localize: 1,
    glob: 1,
    file_tree_summary: 1,
    git_churn: 1,
    git_blame_heatmap: 1,
    // Stage 2 — FUNCTION (symbol within a file)
    read: 2,
    lsp_document_symbol: 2,
    lsp_hover: 2,
    // Stage 3 — EDIT-LOCATION (exact lines / blast radius)
    lsp_references: 3,
    lsp_definition: 3,
    lsp_type_definition: 3,
    lsp_implementation: 3,
    parse_test_failure: 3,
    diagnostics: 3,
    // `grep` is dual-use (S1 candidate search OR S3 line pinning). Classified as
    // Stage 1 here — its most common funnel role is the initial candidate sweep.
    grep: 1,
});
/** Ordered `tool_call` names from a trajectory (seq order assumed by caller). */
const toolCallNames = (events) => {
    const out = [];
    for (const e of events) {
        if (e.kind !== "tool_call")
            continue;
        const name = e.data.name;
        if (typeof name === "string")
            out.push(name);
    }
    return out;
};
/**
 * Observe funnel progression over a trajectory. Pure — exported for unit
 * tests. Walks the tool-call sequence tracking the highest stage reached in
 * MONOTONIC order: a Stage-2 tool only advances the funnel if a Stage-1 tool
 * already fired; Stage-3 only if Stage-2 already fired. Out-of-order funnel
 * tools (e.g. lsp_references with no prior read) do NOT advance — they are
 * still recorded in `sequence`.
 */
export const observeFunnel = (events) => {
    const names = toolCallNames(events);
    const sequence = [];
    let reached = 0;
    for (const name of names) {
        const stage = STAGE_TOOLS[name];
        if (stage === undefined)
            continue;
        sequence.push(name);
        // Advance only one step at a time and only when the prior step was met.
        if (stage === 1 && reached === 0)
            reached = 1;
        else if (stage === 2 && reached === 1)
            reached = 2;
        else if (stage === 3 && reached === 2)
            reached = 3;
    }
    const followed = reached === 3;
    const note = followed
        ? "full file→function→edit-location funnel observed (advisory followed)"
        : reached === 0
            ? "no localization-funnel tools called — run may have used named files or other signals"
            : `funnel reached stage ${reached}/3; not a defect (correct localization can skip stages)`;
    return { followed, stagesReached: reached, sequence, note };
};
/** Plain-text render for the `--funnel` probe view. */
export const renderFunnel = (report) => {
    const seq = report.sequence.length > 0 ? report.sequence.join(" → ") : "(none)";
    return [
        `funnel: ${report.followed ? "FOLLOWED" : "partial"} (stage ${report.stagesReached}/3)`,
        `  sequence: ${seq}`,
        `  note: ${report.note}`,
    ].join("\n");
};
