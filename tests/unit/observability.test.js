import { describe, expect, test } from "bun:test";
import { Metrics, StructuredLogger } from "@/observability";
describe("StructuredLogger", () => {
    test("suppresses below-threshold levels (debug at info)", () => {
        const lines = [];
        const log = new StructuredLogger({ level: "info", sink: (l) => lines.push(l) });
        log.debug("should.be.dropped");
        log.info("should.pass");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? "{}").event).toBe("should.pass");
    });
    test("error level is always emitted even at the highest threshold", () => {
        const lines = [];
        const log = new StructuredLogger({ level: "error", sink: (l) => lines.push(l) });
        log.debug("drop");
        log.info("drop");
        log.warn("drop");
        log.error("kept");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? "{}").event).toBe("kept");
    });
    test("emits one valid JSON line with ts/level/event/fields", () => {
        const lines = [];
        const log = new StructuredLogger({
            level: "debug",
            sink: (l) => lines.push(l),
            now: () => 1_700_000_000_000,
        });
        log.warn("agent.turn.start", { turn: 3, tool: "edit" });
        expect(lines).toHaveLength(1);
        const line = lines[0] ?? "";
        expect(line).not.toContain("\n");
        const rec = JSON.parse(line);
        expect(rec.ts).toBe(1_700_000_000_000);
        expect(rec.level).toBe("warn");
        expect(rec.event).toBe("agent.turn.start");
        expect(rec.fields).toEqual({ turn: 3, tool: "edit" });
    });
    test("fields default to empty object when omitted", () => {
        const lines = [];
        const log = new StructuredLogger({ level: "debug", sink: (l) => lines.push(l) });
        log.info("no.fields");
        expect(JSON.parse(lines[0] ?? "{}").fields).toEqual({});
    });
    test("child logger merges base fields into every record", () => {
        const lines = [];
        const root = new StructuredLogger({ level: "debug", sink: (l) => lines.push(l) });
        const child = root.child({ reqId: "abc" });
        child.info("scoped", { extra: 1 });
        expect(JSON.parse(lines[0] ?? "{}").fields).toEqual({ reqId: "abc", extra: 1 });
    });
});
describe("Metrics", () => {
    test("counter increments (default and explicit delta)", () => {
        const m = new Metrics();
        const c = m.counter("calls");
        c.inc();
        c.inc(4);
        expect(c.value()).toBe(5);
        expect(m.counter("calls").value()).toBe(5); // same handle by name
    });
    test("gauge set/get keeps last write", () => {
        const m = new Metrics();
        const g = m.gauge("queue.depth");
        g.set(10);
        g.set(3);
        expect(g.value()).toBe(3);
        expect(m.snapshot().gauges["queue.depth"]).toBe(3);
    });
    test("timer records elapsed ms via injected fake clock", () => {
        let tick = 0;
        const clock = () => tick;
        const m = new Metrics(clock);
        const t = m.timer("op");
        tick = 100;
        const stop = t.start();
        tick = 142;
        const elapsed = stop();
        expect(elapsed).toBe(42);
        expect(m.snapshot().timers.op?.count).toBe(1);
        expect(m.snapshot().timers.op?.min).toBe(42);
    });
    test("timer.record accepts externally-measured durations", () => {
        const m = new Metrics();
        const t = m.timer("ext");
        t.record(5);
        t.record(15);
        const s = m.snapshot().timers.ext;
        expect(s?.count).toBe(2);
        expect(s?.mean).toBe(10);
    });
    // Percentile method: nearest-rank, rank = ceil(p/100 * n), 1-indexed.
    // Sample 1..100 (n=100): p50 rank = ceil(50) = 50 -> value 50;
    // p95 rank = ceil(95) = 95 -> value 95. Spec's "≈51/≈96" tolerates the
    // off-by-one between percentile definitions; nearest-rank picks the lower.
    test("snapshot percentiles correct for sample 1..100", () => {
        const m = new Metrics();
        const t = m.timer("dist");
        for (let i = 1; i <= 100; i++)
            t.record(i);
        const s = m.snapshot().timers.dist;
        expect(s?.count).toBe(100);
        expect(s?.min).toBe(1);
        expect(s?.max).toBe(100);
        expect(s?.mean).toBeCloseTo(50.5, 5);
        expect(s?.p50).toBeGreaterThanOrEqual(49);
        expect(s?.p50).toBeLessThanOrEqual(51);
        expect(s?.p95).toBeGreaterThanOrEqual(94);
        expect(s?.p95).toBeLessThanOrEqual(96);
    });
    test("empty timer snapshot is zeroed, not NaN", () => {
        const m = new Metrics();
        m.timer("idle");
        const s = m.snapshot().timers.idle;
        expect(s).toEqual({ count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0 });
    });
    test("fresh instances do not share state", () => {
        const a = new Metrics();
        const b = new Metrics();
        a.counter("x").inc(7);
        expect(b.counter("x").value()).toBe(0);
    });
});
