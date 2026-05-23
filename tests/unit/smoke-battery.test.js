import { describe, expect, test } from "bun:test";
import { discoverScenarios, runScenario } from "../smoke/runner";
/**
 * Folds the tier-0 smoke battery into the main `bun test` gate (RFC §1.2 — the
 * deterministic replay tier is part of every PR). Each fixture under
 * `tests/smoke/fixtures/<depth>/` runs its recorded trajectory against the real
 * agent loop + real tools in a tmp workspace; only the LLM is replayed.
 *
 * A scenario WITHOUT a `trajectory.jsonl` is `skipped` (pending recording) and
 * does NOT fail the gate — it is surfaced so coverage gaps stay visible.
 */
describe("smoke battery (tier-0 replay)", () => {
    const scenarios = discoverScenarios();
    test("at least one scenario is discoverable", () => {
        expect(scenarios.length).toBeGreaterThan(0);
    });
    for (const meta of scenarios) {
        test(`${meta.depth}/${meta.id}`, async () => {
            const result = await runScenario(meta);
            if (result.status === "skipped") {
                // Pending recording — allowed, but log it so it's visible.
                expect(result.skipReason).toBeDefined();
                return;
            }
            if (result.status === "failed") {
                const detail = result.failures
                    .map((f) => `  ${f.path}: expected ${f.expected}, got ${f.actual}`)
                    .join("\n");
                throw new Error(`smoke scenario ${meta.id} failed:\n${detail}`);
            }
            expect(result.status).toBe("passed");
        });
    }
});
