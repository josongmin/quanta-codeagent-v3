/**
 * Baseline tracking artifact.
 *
 * A tiny, pure machine-readable report built from `InstanceResult[]` plus
 * run metadata. It is NOT official grading (that requires the Docker
 * harness — see swebench-dataset.ts): `resolved` here reflects the local
 * `testCmd` outcome, which is a no-op for the official-dataset path. The
 * report exists to track baseline runs over time alongside the official
 * `predictions.jsonl`.
 */
import { aggregate, classify, } from "./corpus/failure-classifier";
import { resolvedTotals } from "./observe";
/** Build the report object from results + meta. Pure & deterministic given a
 *  fixed `timestamp` (defaults to now). */
export const buildReport = (meta, results) => {
    // C8: degraded-excluding denominator — the SAME source as observe.summarize
    // / summary.json. Never count a strict-degraded instance here.
    const { resolved, total } = resolvedTotals(results);
    const classifications = results.map((r) => classify(r));
    const failedClassifications = classifications.filter((c) => c.termination !== "passed");
    return {
        timestamp: meta.timestamp ?? new Date().toISOString(),
        model: meta.model,
        provider: meta.provider,
        n: meta.n,
        totals: {
            total,
            resolved,
            resolvedPct: total === 0 ? 0 : Math.round((resolved / total) * 100),
        },
        failureBreakdown: aggregate(failedClassifications),
        perInstance: results.map((r, i) => {
            const c = classifications[i] ?? { termination: "unknown", signals: [] };
            return {
                id: r.id,
                passed: r.passed,
                turns: r.turns,
                patchBytes: Buffer.byteLength(r.patch, "utf8"),
                ...(r.error !== undefined ? { error: r.error } : {}),
                ...(c.termination !== "passed" ? { failure: c } : {}),
            };
        }),
    };
};
/** Write the report as pretty JSON (trailing newline). */
export const writeReport = async (file, report) => {
    await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`);
};
