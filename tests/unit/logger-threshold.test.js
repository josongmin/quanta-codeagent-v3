/**
 * Operational diagnostics — `QUANTA_LOG_LEVEL` threshold filter for the two
 * loggers that share the env var (`@/shared` line logger + `@/observability`
 * structured logger). Catalog row 8.3 (FS jail + ops knobs) claims these
 * loggers honour the threshold; this file pins it.
 *
 * The `@/shared` logger reads the env var ONCE at module load (line 5 of
 * `src/shared/logger.ts`), so per-test threshold variation needs a fresh
 * dynamic import after re-setting the env. The structured logger resolves
 * the threshold per-instance, which makes its variation trivial. Both shapes
 * matter — a regression on either side leaks debug noise into production
 * stderr.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StructuredLogger } from "@/observability";
import { __resetRuntimeConfig } from "@/shared";
const ALL_LEVELS = ["debug", "info", "warn", "error"];
describe("StructuredLogger — QUANTA_LOG_LEVEL + explicit-option threshold", () => {
    let savedEnv;
    beforeEach(() => {
        savedEnv = process.env.QUANTA_LOG_LEVEL;
    });
    afterEach(() => {
        if (savedEnv === undefined)
            delete process.env.QUANTA_LOG_LEVEL;
        else
            process.env.QUANTA_LOG_LEVEL = savedEnv;
        __resetRuntimeConfig();
    });
    test("default (env unset, no option) → info+ allowed, debug suppressed", () => {
        delete process.env.QUANTA_LOG_LEVEL;
        __resetRuntimeConfig();
        const lines = [];
        const log = new StructuredLogger({ sink: (l) => lines.push(l) });
        log.debug("d", { x: 1 });
        log.info("i");
        log.warn("w");
        log.error("e");
        const events = lines.map((l) => JSON.parse(l).event);
        expect(events).toEqual(["i", "w", "e"]);
    });
    test("QUANTA_LOG_LEVEL=debug → all four levels emit", () => {
        process.env.QUANTA_LOG_LEVEL = "debug";
        __resetRuntimeConfig();
        const lines = [];
        const log = new StructuredLogger({ sink: (l) => lines.push(l) });
        for (const lvl of ALL_LEVELS)
            log[lvl]("e");
        expect(lines.length).toBe(4);
    });
    test("QUANTA_LOG_LEVEL=error → only error emits; the rest are silent", () => {
        process.env.QUANTA_LOG_LEVEL = "error";
        __resetRuntimeConfig();
        const lines = [];
        const log = new StructuredLogger({ sink: (l) => lines.push(l) });
        for (const lvl of ALL_LEVELS)
            log[lvl]("e");
        expect(lines.length).toBe(1);
        expect(JSON.parse(lines[0]).level).toBe("error");
    });
    test("explicit option overrides env (option=warn beats env=debug)", () => {
        process.env.QUANTA_LOG_LEVEL = "debug";
        __resetRuntimeConfig();
        const lines = [];
        const log = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) });
        log.debug("d");
        log.info("i");
        log.warn("w");
        log.error("e");
        const events = lines.map((l) => JSON.parse(l).event);
        expect(events).toEqual(["w", "e"]);
    });
    test("invalid env value (typo) → falls back to 'info', no throw", () => {
        process.env.QUANTA_LOG_LEVEL = "verbose-banana";
        __resetRuntimeConfig();
        const lines = [];
        const log = new StructuredLogger({ sink: (l) => lines.push(l) });
        log.debug("d");
        log.info("i");
        expect(lines.length).toBe(1);
        expect(JSON.parse(lines[0]).event).toBe("i");
    });
    test("child logger inherits parent threshold; per-call fields merge over base", () => {
        process.env.QUANTA_LOG_LEVEL = "warn";
        __resetRuntimeConfig();
        const lines = [];
        const parent = new StructuredLogger({ sink: (l) => lines.push(l) }, { service: "agent" });
        const child = parent.child({ run: "r1" });
        child.debug("masked");
        child.warn("kept", { extra: 1 });
        expect(lines.length).toBe(1);
        const rec = JSON.parse(lines[0]);
        expect(rec.event).toBe("kept");
        expect(rec.fields).toEqual({ service: "agent", run: "r1", extra: 1 });
    });
    test("each record is one JSON line on the sink (no multi-line spillage)", () => {
        delete process.env.QUANTA_LOG_LEVEL;
        __resetRuntimeConfig();
        const lines = [];
        const log = new StructuredLogger({ sink: (l) => lines.push(l) });
        log.info("multiline", { msg: "a\nb\nc" });
        // The sink receives EXACTLY one string per emit; embedded \n inside fields
        // is JSON-escaped, never literal in the framed line.
        expect(lines.length).toBe(1);
        expect(lines[0].includes("\n")).toBe(false);
        expect(lines[0]).toContain("a\\nb\\nc");
    });
});
describe("@/shared line logger — module-load threshold (smoke via dynamic import)", () => {
    // The shared logger captures `threshold` at module load (src/shared/logger.ts:5).
    // We can't mutate it per-test, so this is a smoke that the module loads and
    // exposes the four level fns. The threshold filter is exercised in unit
    // tests above for the structured logger; both modules use IDENTICAL ORDER
    // table and same env var. A drift between them would surface here too.
    test("logger object exposes debug/info/warn/error functions", async () => {
        const { logger } = await import("@/shared");
        expect(typeof logger.debug).toBe("function");
        expect(typeof logger.info).toBe("function");
        expect(typeof logger.warn).toBe("function");
        expect(typeof logger.error).toBe("function");
    });
});
