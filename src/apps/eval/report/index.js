/**
 * Tier-agnostic reporter. Reads the whole store, builds the matrix, renders
 * markdown. The CLI subcommand `eval report` writes to stdout (or a file via
 * shell redirect); programmatic callers receive the strings directly.
 */
import { ResultStore } from "../storage";
import { buildCoverageMatrix } from "./coverage-matrix";
import { renderHeadline, renderMatrixMarkdown } from "./markdown";
export { buildCoverageMatrix, renderHeadline, renderMatrixMarkdown };
export const buildReport = (opts = {}) => {
    const store = new ResultStore({ ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}) });
    const matrix = buildCoverageMatrix(store.readAll());
    return {
        headline: renderHeadline(matrix),
        markdown: renderMatrixMarkdown(matrix),
        matrix,
    };
};
