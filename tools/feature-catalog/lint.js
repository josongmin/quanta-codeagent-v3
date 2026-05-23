/**
 * Feature-catalog ratchet — refuses *growth* of known slop.
 *
 * The catalog has a pre-existing backlog of migrated-shell stubs that we won't
 * fix in one batch (each needs careful per-stub investigation). The lint
 * doesn't try to *fix* the backlog — it just prevents it from getting WORSE.
 *
 *   - empty stubs    — HARD cap at baseline; new shells block CI.
 *   - orphan ADRs    — HARD cap at 0 for Accepted ADRs (and at baseline for the
 *                      one-time grandfather list when migration leftovers exist).
 *   - orphan src     — SOFT signal only: count returned, no fail (leaf helpers
 *                      legitimately exist; this number drifts naturally).
 *
 * The baseline lives in `baseline.json` under the `fc` subobject. `bun fc lint`
 * compares the audit's current counts against that baseline and exits non-zero
 * on growth. To consciously raise the cap (e.g. after a refactor adds files
 * faster than fc entries), run `bun fc lint --update-baseline` — that move is
 * explicit and review-visible.
 */
import { readFile, writeFile } from "node:fs/promises";
/** Pure lint — given current audit + baseline, decide pass/fail. */
export function runLint(report, baseline) {
    const errors = [];
    const warnings = [];
    if (report.counts.emptyStubs > baseline.empty_stubs_max) {
        errors.push(`empty stubs: ${report.counts.emptyStubs} > baseline ${baseline.empty_stubs_max}. ` +
            `New empty stub(s) added. Either fill them in, or run \`bun fc lint --update-baseline\` if intentional.`);
    }
    const grandfathered = new Set(baseline.orphan_adrs_grandfathered);
    const newOrphans = report.orphanAdrs.filter((n) => !grandfathered.has(n));
    if (newOrphans.length > 0) {
        errors.push(`orphan Accepted ADRs not in fc: ${newOrphans
            .map((n) => `ADR-${String(n).padStart(4, "0")}`)
            .join(", ")}. ` +
            `Add an fc entry that references the ADR, or grandfather via --update-baseline.`);
    }
    if (report.counts.emptyStubs < baseline.empty_stubs_max) {
        warnings.push(`empty stubs ratchet can tighten: ${report.counts.emptyStubs} < baseline ${baseline.empty_stubs_max}. ` +
            `Run \`bun fc lint --update-baseline\` to lock in the improvement.`);
    }
    const stillGrandfathered = report.orphanAdrs.filter((n) => grandfathered.has(n));
    const removedFromOrphan = baseline.orphan_adrs_grandfathered.filter((n) => !report.orphanAdrs.includes(n));
    if (removedFromOrphan.length > 0) {
        warnings.push(`${removedFromOrphan.length} grandfathered orphan ADR(s) now wired up: ` +
            `${removedFromOrphan.map((n) => `ADR-${String(n).padStart(4, "0")}`).join(", ")}. ` +
            `Run --update-baseline to remove them from the grandfather list.`);
    }
    if (stillGrandfathered.length > 0) {
        warnings.push(`${stillGrandfathered.length} grandfathered orphan ADR(s) still unwired (informational).`);
    }
    return { ok: errors.length === 0, errors, warnings };
}
/** Build a fresh baseline snapshot from a current audit. */
export function snapshotBaseline(report, now = () => new Date()) {
    return {
        empty_stubs_max: report.counts.emptyStubs,
        orphan_adrs_grandfathered: report.orphanAdrs.slice().sort((a, b) => a - b),
        updated_at: now().toISOString(),
    };
}
const DEFAULT_BASELINE = {
    empty_stubs_max: 0,
    orphan_adrs_grandfathered: [],
    updated_at: "1970-01-01T00:00:00.000Z",
};
/** Read `baseline.json` and pull the `fc` sub-object. Missing file or missing
 *  sub-object → DEFAULT_BASELINE (zero cap — strict). */
export async function loadFcBaseline(path = "tools/feature-catalog/baseline.json") {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT")
            return DEFAULT_BASELINE;
        throw err;
    }
    const raw = JSON.parse(text);
    const fc = raw.fc;
    if (fc === undefined ||
        typeof fc.empty_stubs_max !== "number" ||
        !Array.isArray(fc.orphan_adrs_grandfathered) ||
        typeof fc.updated_at !== "string") {
        return DEFAULT_BASELINE;
    }
    return {
        empty_stubs_max: fc.empty_stubs_max,
        orphan_adrs_grandfathered: fc.orphan_adrs_grandfathered.filter((n) => typeof n === "number"),
        updated_at: fc.updated_at,
    };
}
/** Write the fc subobject back into baseline.json without disturbing the rest.
 *  Atomic: read-modify-write the whole file. */
export async function saveFcBaseline(fc, path = "tools/feature-catalog/baseline.json") {
    let raw = {};
    try {
        raw = JSON.parse(await readFile(path, "utf8"));
    }
    catch (err) {
        const code = err.code;
        if (code !== "ENOENT")
            throw err;
    }
    raw.fc = {
        empty_stubs_max: fc.empty_stubs_max,
        orphan_adrs_grandfathered: fc.orphan_adrs_grandfathered.slice(),
        updated_at: fc.updated_at,
    };
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
