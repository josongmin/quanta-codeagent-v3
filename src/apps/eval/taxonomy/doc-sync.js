/**
 * Render the in-code `TAXONOMY` to the `docs/analysis/...md` view.
 *
 * Single direction: code → doc. The markdown file is a *generated view* — if
 * you want to add/rename a leaf, edit `usecases.ts` and re-run this. Editing
 * the markdown by hand creates drift that the unit test cannot detect.
 *
 * Output shape matches the existing `may-21-coding-agent-query-usecase.md` §1
 * tables (one table per major) so a diff after a code change is the smallest
 * meaningful unit.
 */
import { TAXONOMY } from "./usecases";
const escapeCell = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const exampleCell = (l) => {
    if (l.examples.length === 0)
        return "—";
    return l.examples.map((e) => `"${e}"`).join(", ");
};
/** Markdown for ONE major. Header + table of (중분류 | 소분류 | 트리거 | 커버 | 담당 | 검증). */
const renderMajor = (major) => {
    const lines = [];
    const share = major.empiricalShare !== undefined ? ` (${Math.round(major.empiricalShare * 100)}%)` : "";
    lines.push(`### ${major.label}${share}`);
    lines.push("");
    lines.push("| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |");
    lines.push("|---|---|---|---|---|---|");
    for (const m of major.mids) {
        for (const l of m.leaves) {
            lines.push(`| ${escapeCell(m.label)} | ${escapeCell(l.label)} | ${escapeCell(exampleCell(l))} | TBD |  |  |`);
        }
    }
    lines.push("");
    return lines.join("\n");
};
/** Full rendered taxonomy section (no document header — the surrounding md keeps the intro). */
export const renderTaxonomyMarkdown = () => {
    const sections = TAXONOMY.map(renderMajor);
    return sections.join("\n");
};
