/**
 * ADR-0036: cross-check every tool name in the v3 registry against the
 * plan-mode mutating table. A missing entry is a CI failure — adding a new
 * tool MUST consciously classify its mutating kind, or plan mode could
 * silently allow it. Conversely, table entries that no longer correspond
 * to a real tool are also flagged (drift in the other direction).
 */
import { describe, expect, test } from "bun:test";
import { isMutatingTool, planModeMutatingTable, UnknownToolError } from "@/agent/mode";
import { createUpdateWorkingStateTool, defaultTools, gitTools, lspNavTools, nullLspNavProvider, } from "@/tool";
describe("mode mutating-table cross-check (ADR-0036)", () => {
    const allTools = [
        ...defaultTools.map((t) => t.name),
        ...gitTools().map((t) => t.name),
        ...lspNavTools(nullLspNavProvider).map((t) => t.name),
        createUpdateWorkingStateTool(undefined).name,
    ];
    test("every registered tool name has an entry in the mutating table", () => {
        const table = planModeMutatingTable();
        const missing = [];
        for (const name of allTools) {
            if (!(name in table))
                missing.push(name);
        }
        expect(missing).toEqual([]);
    });
    test("every entry in the mutating table corresponds to a known tool", () => {
        const table = planModeMutatingTable();
        const orphans = [];
        for (const name of Object.keys(table)) {
            if (!allTools.includes(name))
                orphans.push(name);
        }
        // Tools may exist in the table that are not in the *default* set if a
        // future tool is registered conditionally. For this baseline, the
        // assertion is exact — drift in either direction surfaces here.
        expect(orphans).toEqual([]);
    });
    test("isMutatingTool returns boolean for every registered tool", () => {
        for (const name of allTools) {
            const v = isMutatingTool(name);
            expect(typeof v).toBe("boolean");
        }
    });
    test("isMutatingTool throws UnknownToolError for an unregistered name", () => {
        expect(() => isMutatingTool("totally_not_a_real_tool")).toThrow(UnknownToolError);
        try {
            isMutatingTool("nope_v2");
        }
        catch (err) {
            expect(err).toBeInstanceOf(UnknownToolError);
            expect(err.toolName).toBe("nope_v2");
        }
    });
    test("mutating kinds are exactly those expected for the v3 baseline", () => {
        const table = planModeMutatingTable();
        expect(table.write).toBe("write_filesystem");
        expect(table.edit).toBe("write_filesystem");
        expect(table.scripted_replace).toBe("write_filesystem");
        expect(table.bash).toBe("bash_mutating");
        expect(table.update_working_state).toBe("working_state_write");
        expect(table.read).toBeNull();
        expect(table.grep).toBeNull();
        expect(table.glob).toBeNull();
        expect(table.diagnostics).toBeNull();
        expect(table.git_status).toBeNull();
        expect(table.git_diff).toBeNull();
    });
});
