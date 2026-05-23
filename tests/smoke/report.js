import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Coverage report — answers "which agent use-cases does the battery exercise?"
 * by mining each scenario's `expect.json` (declared tools + safety sentinels)
 * and its depth/tags, then overlaying the run outcome.
 *
 * Two views:
 *   - Tool × depth matrix: for each tool, how many scenarios at each depth
 *     REQUIRE it (toolCalls.required). Surfaces gaps ("no tikitaka exercises
 *     bash").
 *   - Safety coverage: how many scenarios assert a `forbidden` tool sentinel.
 */
const DEPTHS = ["single", "medium", "tikitaka"];
const readExpect = (dir) => {
    const p = join(dir, "expect.json");
    if (!existsSync(p))
        return {};
    return JSON.parse(readFileSync(p, "utf8"));
};
export const renderCoverage = (scenarios, results) => {
    const toolByDepth = new Map();
    const forbidden = new Map();
    let withJudge = 0;
    let withContextRetention = 0;
    let withForbidden = 0;
    for (const meta of scenarios) {
        const spec = readExpect(meta.dir);
        for (const tool of spec.toolCalls?.required ?? []) {
            const row = toolByDepth.get(tool) ?? {};
            row[meta.depth] = (row[meta.depth] ?? 0) + 1;
            toolByDepth.set(tool, row);
        }
        for (const tool of spec.toolCalls?.forbidden ?? []) {
            forbidden.set(tool, (forbidden.get(tool) ?? 0) + 1);
        }
        if ((spec.toolCalls?.forbidden ?? []).length > 0)
            withForbidden += 1;
        if (spec.judge !== undefined)
            withJudge += 1;
        if ((spec.contextRetention ?? []).length > 0)
            withContextRetention += 1;
    }
    const lines = [];
    lines.push("── coverage ──────────────────────────────");
    const byDepth = DEPTHS.map((d) => `${d}=${scenarios.filter((s) => s.depth === d).length}`).join(" · ");
    lines.push(`scenarios: ${scenarios.length}  (${byDepth})`);
    lines.push("");
    lines.push("tool × depth (required):");
    const tools = [...toolByDepth.keys()].sort();
    const pad = (s, n) => s.padEnd(n);
    lines.push(`  ${pad("tool", 16)}${DEPTHS.map((d) => pad(d, 10)).join("")}`);
    for (const tool of tools) {
        const row = toolByDepth.get(tool) ?? {};
        lines.push(`  ${pad(tool, 16)}${DEPTHS.map((d) => pad(String(row[d] ?? 0), 10)).join("")}`);
    }
    lines.push("");
    lines.push(`assertions: ${withForbidden} use forbidden-tool sentinels · ${withContextRetention} context-retention · ${withJudge} llm-judge`);
    if (forbidden.size > 0) {
        const fb = [...forbidden.entries()].map(([t, n]) => `${t}(${n})`).join(" ");
        lines.push(`forbidden sentinels: ${fb}`);
    }
    if (results.length > 0) {
        const passed = results.filter((r) => r.status === "passed").length;
        const failed = results.filter((r) => r.status === "failed").length;
        const skipped = results.filter((r) => r.status === "skipped").length;
        lines.push("");
        lines.push(`results: ${passed} passed · ${failed} failed · ${skipped} skipped`);
    }
    lines.push("──────────────────────────────────────────");
    return lines.join("\n");
};
