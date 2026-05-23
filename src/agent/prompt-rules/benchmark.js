/**
 * Benchmark pack (batch mode).
 *
 * Batch / bench runs are graded by an external harness — exploration without
 * an edit yields no scoring delta. The extra rule pushes the loop to stop
 * once it has a coherent patch + a verify step, instead of burning turns on
 * further investigation that won't change the score.
 */
import { CORE_RULES } from "./core";
const BATCH_RULES = [
    {
        id: "R-NO-EXPLORE-OVER-EDIT",
        lines: [
            "- [R-NO-EXPLORE-OVER-EDIT] Tests are graded by external harness. Stop",
            "  exploring once you have a coherent edit and a verify step; further",
            "  exploration without an edit yields no scoring delta.",
        ],
    },
];
/** Batch-mode pack = core rules + the explore-over-edit gate. */
export const BENCHMARK_PACK = [...CORE_RULES, ...BATCH_RULES];
