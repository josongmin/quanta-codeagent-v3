import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent } from "@/shared";
import { loadRun, loadTrajectory } from "../../src/apps/probe/parse";
let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "probe-parse-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
const CTX = { runId: "r1", instanceId: "i1", attempt: 0 };
const line = (seq, kind, data = {}) => `${JSON.stringify(makeEvent(seq, kind, CTX, data, { ts: 1_700_000_000_000 }))}\n`;
describe("loadTrajectory", () => {
    test("parses valid JSONL and sorts by seq (stable)", () => {
        const file = join(dir, "t.jsonl");
        writeFileSync(file, line(2, "turn_start", { turn: 1 }) +
            line(0, "session_start") +
            line(1, "assistant_text", { delta: "hi" }));
        const r = loadTrajectory(file);
        expect(r.events.map((e) => e.seq)).toEqual([0, 1, 2]);
        expect(r.skipped).toBe(0);
    });
    test("keeps valid lines, counts garbage + wrong-schema, never throws", () => {
        const file = join(dir, "mixed.jsonl");
        writeFileSync(file, `${line(0, "session_start")}not-json-at-all\n${JSON.stringify({ schema: "other.v9", seq: 9 })}\n${line(1, "session_end", { reason: "stop", turns: 1 })}`);
        const r = loadTrajectory(file);
        expect(r.events).toHaveLength(2);
        expect(r.skipped).toBe(2);
        expect(r.events.map((e) => e.kind)).toEqual(["session_start", "session_end"]);
    });
    test("missing file → empty events + a warning, no throw", () => {
        const r = loadTrajectory(join(dir, "nope.jsonl"));
        expect(r.events).toHaveLength(0);
        expect(r.warnings.length).toBeGreaterThan(0);
    });
    test("does not mutate input ordering of equal seq (stable sort)", () => {
        const file = join(dir, "eq.jsonl");
        writeFileSync(file, line(0, "assistant_text", { delta: "a" }) + line(0, "assistant_text", { delta: "b" }));
        const r = loadTrajectory(file);
        expect(r.events.map((e) => e.data.delta)).toEqual(["a", "b"]);
    });
});
describe("loadRun", () => {
    test("discovers <id>.<attempt>.jsonl files grouped by instance", () => {
        writeFileSync(join(dir, "alpha.0.jsonl"), line(0, "session_start"));
        writeFileSync(join(dir, "alpha.1.jsonl"), line(0, "session_start"));
        writeFileSync(join(dir, "beta.0.jsonl"), line(0, "session_start"));
        const run = loadRun(dir);
        expect([...run.instances.keys()].sort()).toEqual(["alpha", "beta"]);
        expect(run.instances.get("alpha")).toHaveLength(2);
        expect(run.instances.get("beta")).toHaveLength(1);
    });
    test("discovers session.jsonl as a single instance", () => {
        writeFileSync(join(dir, "session.jsonl"), line(0, "session_start"));
        const run = loadRun(dir);
        expect([...run.instances.keys()]).toEqual(["session"]);
    });
    test("reads summary.json / metrics.json when present", () => {
        writeFileSync(join(dir, "i1.0.jsonl"), line(0, "session_start"));
        writeFileSync(join(dir, "summary.json"), JSON.stringify({ runId: "r1", resolved: 1, total: 2, degraded: 0, instances: [] }));
        writeFileSync(join(dir, "metrics.json"), JSON.stringify({ runId: "r1", pricingVersion: "pricing.v1", snapshot: {} }));
        const run = loadRun(dir);
        expect(run.summary?.resolved).toBe(1);
        expect(run.metrics?.pricingVersion).toBe("pricing.v1");
        expect(run.runId).toBe("r1");
    });
    test("tolerates absent summary/metrics", () => {
        writeFileSync(join(dir, "i1.0.jsonl"), line(0, "session_start"));
        const run = loadRun(dir);
        expect(run.summary).toBeUndefined();
        expect(run.metrics).toBeUndefined();
    });
    test("malformed run file → parse warning, not a throw", () => {
        writeFileSync(join(dir, "bad.0.jsonl"), "}{ totally broken\n{ nope\n");
        writeFileSync(join(dir, "summary.json"), "{ not valid json");
        const run = loadRun(dir);
        expect(run.instances.has("bad")).toBe(true);
        expect(run.warnings.length).toBeGreaterThan(0);
    });
    test("a single trajectory file path → one instance", () => {
        const file = join(dir, "solo.0.jsonl");
        writeFileSync(file, line(0, "session_start"));
        const run = loadRun(file);
        expect([...run.instances.keys()]).toEqual(["solo"]);
    });
});
