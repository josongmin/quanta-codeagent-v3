/**
 * Stress / hot-path smoke tests for the Plan-mode dispatch seam.
 *
 * 1. 100,000 isMutatingTool calls cycling through the known table — assert
 *    COMPLETION (no infinite loop, no allocation explosion) and log timing
 *    as a soft signal. The intent is to catch a future "fix" that turns the
 *    O(1) object-lookup into an O(n²) Map<string,object> or similar.
 *
 * 2. 100,000 mode transition cycles (default ↔ plan via developer messages)
 *    — assert final state via a parity argument: after an EVEN number of
 *    flips from default, the final state is default; ODD ⇒ plan. No
 *    exception in the loop.
 *
 * Hard rules honored: no sleeps, no swallows, no fallback. The perf threshold
 * is intentionally loose (soft signal) because CI machine variance would
 * otherwise force a heuristic.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { applyDeveloperModeTransition, isMutatingTool, planModeMutatingTable, } from "@/agent/mode";
import { __resetRuntimeConfig } from "@/shared";
/* ────────────────────────────── env baseline ─────────────────────────────── */
const QUANTA_ENV_BASELINE = Object.fromEntries(Object.keys(process.env)
    .filter((k) => k.startsWith("QUANTA_"))
    .map((k) => [k, process.env[k]]));
beforeEach(() => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith("QUANTA_") && !(k in QUANTA_ENV_BASELINE))
            delete process.env[k];
    }
    for (const [k, v] of Object.entries(QUANTA_ENV_BASELINE)) {
        if (v === undefined)
            delete process.env[k];
        else
            process.env[k] = v;
    }
    __resetRuntimeConfig();
});
/* ─────────────────── 100k isMutatingTool hot path ───────────────────────── */
describe("stress: 100k isMutatingTool calls", () => {
    test("cycle through every known tool 100,000 times — completes without throwing", () => {
        const names = Object.keys(planModeMutatingTable());
        expect(names.length).toBeGreaterThan(0);
        const start = process.hrtime.bigint();
        let trueCount = 0;
        let falseCount = 0;
        for (let i = 0; i < 100_000; i++) {
            const n = names[i % names.length] ?? "read";
            if (isMutatingTool(n))
                trueCount++;
            else
                falseCount++;
        }
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        // Parity check: 100_000 calls evenly distributed by index across N tools
        // means each tool is called ⌈100_000/N⌉ or ⌊100_000/N⌋ times. The counts
        // must add up to exactly 100_000 (no swallowed call).
        expect(trueCount + falseCount).toBe(100_000);
        expect(trueCount).toBeGreaterThan(0);
        expect(falseCount).toBeGreaterThan(0);
        // Soft signal: log timing. NOT a hard gate — CI variance would force a
        // heuristic. The intent is to catch O(n²) regressions: if someone "fixes"
        // the table by serializing per call, this test wall-clocks at minutes.
        // eslint-disable-next-line no-console -- intentional perf signal
        console.log(`[stress] 100k isMutatingTool calls completed in ${elapsedMs.toFixed(1)}ms`);
        // Generous ceiling: a properly O(1) implementation easily fits in 5s; if
        // we ever hit this, something has gone REALLY wrong (memory thrash,
        // allocation explosion). The intent is to flag pathology, not to gate
        // perf — hence the loose bound.
        expect(elapsedMs).toBeLessThan(5000);
    });
});
/* ─────────────────── 100k mode-transition cycles ────────────────────────── */
describe("stress: 100k mode transition cycles", () => {
    test("default ↔ plan flip 100,000 times — no exception, parity holds", () => {
        let mode = "default";
        let flipCount = 0;
        const start = process.hrtime.bigint();
        for (let i = 0; i < 100_000; i++) {
            const next = mode === "default" ? "plan" : "default";
            const newMode = applyDeveloperModeTransition(mode, `mode=${next}`);
            // Each call must in fact transition (not stick).
            expect(newMode).toBe(next);
            mode = newMode;
            flipCount++;
        }
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        expect(flipCount).toBe(100_000);
        // Parity: started at default, flipped even number of times (100_000 is
        // even) → end at default.
        expect(mode).toBe("default");
        // eslint-disable-next-line no-console -- intentional perf signal
        console.log(`[stress] 100k mode transitions completed in ${elapsedMs.toFixed(1)}ms`);
        expect(elapsedMs).toBeLessThan(5000);
    });
    test("interleaved valid + no-op transitions also obey parity", () => {
        // 50_000 actual flips intermixed with 50_000 no-ops (same-mode directive).
        let mode = "default";
        let flips = 0;
        for (let i = 0; i < 100_000; i++) {
            if (i % 2 === 0) {
                // no-op: ask for the same mode you're already in
                const newMode = applyDeveloperModeTransition(mode, `mode=${mode}`);
                expect(newMode).toBe(mode);
            }
            else {
                const next = mode === "default" ? "plan" : "default";
                mode = applyDeveloperModeTransition(mode, `mode=${next}`);
                flips++;
            }
        }
        expect(flips).toBe(50_000);
        // Started default; 50_000 flips (even) → back at default.
        expect(mode).toBe("default");
    });
});
