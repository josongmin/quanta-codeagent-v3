/** Run all three pure lenses and return a single report. */
export function runAudit(input) {
    const referencedAdrs = collectReferencedAdrs(input.features);
    const referencedSrc = collectReferencedSrc(input.features);
    const orphanAdrs = input.adrs
        .filter((a) => a.status === "Accepted" && !referencedAdrs.has(a.number))
        .map((a) => a.number)
        .sort((a, b) => a - b);
    const orphanSrcFiles = input.srcFiles
        .filter((p) => !referencedSrc.has(p))
        .slice()
        .sort();
    const emptyStubs = input.features
        .filter(({ feature }) => isEmptyStub(feature))
        .map(({ feature, path }) => ({ id: feature.id, title: feature.title, path }))
        .sort((a, b) => a.path.localeCompare(b.path));
    return {
        orphanAdrs,
        orphanSrcFiles,
        emptyStubs,
        counts: {
            orphanAdrs: orphanAdrs.length,
            orphanSrcFiles: orphanSrcFiles.length,
            emptyStubs: emptyStubs.length,
            totalFeatures: input.features.length,
            totalAdrs: input.adrs.length,
            totalSrcFiles: input.srcFiles.length,
        },
    };
}
/** True iff the feature has fully-empty evidence: no code, no adrs, no tests. */
export function isEmptyStub({ evidence }) {
    if (evidence.code.length > 0)
        return false;
    if (evidence.adrs.length > 0)
        return false;
    if (evidence.tests.unit.length > 0)
        return false;
    if (evidence.tests.integration.length > 0)
        return false;
    if (evidence.tests.contract.length > 0)
        return false;
    return true;
}
function collectReferencedAdrs(features) {
    const out = new Set();
    for (const { feature } of features) {
        for (const n of feature.evidence.adrs)
            out.add(n);
    }
    return out;
}
function collectReferencedSrc(features) {
    const out = new Set();
    for (const { feature } of features) {
        for (const p of feature.evidence.code)
            out.add(p);
    }
    return out;
}
/** Parse the verbatim status string from an ADR markdown file's front-matter
 *  block. Looks for the first `- **Status**: X` or `- **상태**: X` line.
 *  Returns the first non-whitespace token after the colon, or `""` if absent.
 *  Pure — caller provides the file contents. */
export function parseAdrStatus(markdown) {
    for (const line of markdown.split("\n").slice(0, 30)) {
        const m = /^- \*\*(?:Status|상태)\*\*:\s*(\S+)/.exec(line);
        if (m)
            return m[1] ?? "";
    }
    return "";
}
/** Render the report as a human-readable text block. Used by `bun fc audit`. */
export function formatAuditReport(r) {
    const lines = [];
    lines.push(`audit: ${r.counts.totalFeatures} features / ${r.counts.totalAdrs} ADRs / ${r.counts.totalSrcFiles} src files`);
    lines.push("");
    lines.push(`orphan ADRs (Accepted, no fc reference): ${r.counts.orphanAdrs}`);
    for (const n of r.orphanAdrs)
        lines.push(`  ADR-${String(n).padStart(4, "0")}`);
    lines.push("");
    lines.push(`empty stubs (code:[] adrs:[] tests:[]): ${r.counts.emptyStubs}`);
    for (const s of r.emptyStubs.slice(0, 20))
        lines.push(`  ${s.path}  (${s.id})`);
    if (r.emptyStubs.length > 20)
        lines.push(`  ... and ${r.emptyStubs.length - 20} more`);
    lines.push("");
    lines.push(`orphan src files (no fc evidence): ${r.counts.orphanSrcFiles}`);
    for (const p of r.orphanSrcFiles.slice(0, 20))
        lines.push(`  ${p}`);
    if (r.orphanSrcFiles.length > 20)
        lines.push(`  ... and ${r.orphanSrcFiles.length - 20} more`);
    return lines.join("\n");
}
