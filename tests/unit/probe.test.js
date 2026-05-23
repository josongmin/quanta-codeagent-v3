/**
 * Probe golden tests (RFC-0002 §11, Wave E).
 *
 * The fixtures are built from REAL `@/shared` `makeEvent` calls so the goldens
 * track the actual `quanta.trajectory.v1` schema (if the schema drifts, these
 * break first). Deterministic: `ts`/`seq` are injected, no network, no LLM.
 *
 * What is pinned:
 *  - parser tolerates blank / malformed / unknown-schema lines (skips+counts,
 *    never throws);
 *  - span pairing (tool_call↔tool_result, llm_request↔llm_usage via
 *    spanId/parentSpanId) survives the round-trip;
 *  - triage confidence ∈ [0,1] for every class AND the rendered/JSON output
 *    contains NO authoritative/verdict wording (the non-authoritative contract);
 *  - hotspots are ordered by duration (derived from events only);
 *  - cost math stamps pricingVersion and yields null for an unknown model;
 *  - `--json` shape is stable and self-labels as a hypothesis.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** W1-C/D audit finding: this file used `mkdtempSync` 5x with NO cleanup,
 *  leaking /tmp dirs on every test run. Each call-site now routes through
 *  `tmp(prefix)` which registers the dir for `afterAll` removal. */
const tmpDirs = [];
const tmp = (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
};
afterAll(() => {
    for (const d of tmpDirs) {
        try {
            rmSync(d, { recursive: true, force: true });
        }
        catch {
            // best-effort cleanup; ignore EBUSY/EACCES from a parallel reader
        }
    }
});
import { makeEvent } from "@/shared";
import { main } from "../../src/apps/probe/index";
import { loadRun, loadTrajectory } from "../../src/apps/probe/parse";
import { renderCost, renderHotspots, renderTimeline } from "../../src/apps/probe/render";
import { triage } from "../../src/apps/probe/triage";
const CTX = { runId: "run-test", instanceId: "inst-1", attempt: 0 };
let seq = 0;
const ev = (kind, data, opts = {}) => makeEvent(seq++, kind, CTX, data, { ts: 1_000 + seq, ...opts });
const toJsonl = (events) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
/** A small but representative failing trajectory (verify failed). */
const buildFailing = () => {
    seq = 0;
    return [
        ev("session_start", { agent: "quanta" }),
        ev("turn_start", { turn: 0 }, { spanId: "t0" }),
        ev("llm_request", { model: "gpt-4o" }, { spanId: "llm0", parentSpanId: "t0" }),
        ev("llm_usage", { model: "gpt-4o", inputTokens: 1000, outputTokens: 200, costUsd: null }, { spanId: "llm0", parentSpanId: "t0" }),
        ev("assistant_text", { delta: "I will edit the file." }, { parentSpanId: "t0" }),
        ev("tool_call", { name: "bash" }, { spanId: "tool:bash:1", parentSpanId: "t0" }),
        ev("tool_result", { name: "bash", ok: true, exitCode: 0, durationMs: 1200, stdoutTail: "ok", stderrTail: "" }, { spanId: "tool:bash:1", parentSpanId: "t0", monotonicNs: 1_200_000_000 }),
        ev("tool_call", { name: "edit" }, { spanId: "tool:edit:2", parentSpanId: "t0" }),
        ev("tool_result", {
            name: "edit",
            ok: true,
            exitCode: 0,
            durationMs: 50,
            stdoutTail: "patched",
            stderrTail: "",
        }, { spanId: "tool:edit:2", parentSpanId: "t0", monotonicNs: 50_000_000 }),
        ev("patch_generated", {
            diffPath: "/tmp/p.diff",
            filesChanged: 1,
            hunks: 2,
            applyStatus: "clean",
        }),
        ev("patch_applied", {
            diffPath: "/tmp/p.diff",
            filesChanged: 1,
            hunks: 2,
            applyStatus: "applied",
        }),
        ev("verify", {
            command: "pytest",
            exitCode: 1,
            passed: false,
            failedTests: ["test_foo"],
            logTail: "AssertionError: expected 2 got 1",
            reportPath: "/tmp/report.json",
        }),
        ev("session_end", { reason: "completed", turns: 1 }),
    ];
};
describe("probe parser — tolerant ingest (RFC §3.7 forward-compat)", () => {
    const mkFile = (body) => {
        const dir = tmp("probe-parse-");
        const f = join(dir, "inst-1.0.jsonl");
        writeFileSync(f, body);
        return f;
    };
    test("blank / malformed / unknown-schema lines are skipped + counted, never thrown", () => {
        const good = buildFailing();
        const body = `${JSON.stringify(good[0])}\n` +
            "\n" + // blank
            "   \n" + // whitespace-only
            "{ not json at all\n" + // malformed
            `${JSON.stringify({ schema: "quanta.trajectory.v2", v: 2, future: true })}\n` + // unknown schema
            `${JSON.stringify({ hello: "world" })}\n` + // foreign object
            `${JSON.stringify(good[1])}\n`;
        const f = mkFile(body);
        let parsed;
        expect(() => {
            parsed = loadTrajectory(f);
        }).not.toThrow();
        expect(parsed?.events.length).toBe(2); // only the two valid v1 events
        expect(parsed?.skipped).toBe(3); // malformed + unknown-schema + foreign (blanks excluded)
        expect(parsed?.warnings.length).toBeGreaterThan(0);
    });
    test("a missing file degrades to empty + warning, never throws", () => {
        let r;
        expect(() => {
            r = loadTrajectory("/no/such/path/inst.0.jsonl");
        }).not.toThrow();
        expect(r?.events).toEqual([]);
        expect(r?.warnings.join(" ")).toContain("unreadable");
    });
    test("loadRun on a missing path warns and never throws", () => {
        let r;
        expect(() => {
            r = loadRun("/no/such/run-dir");
        }).not.toThrow();
        expect(r?.instances.size).toBe(0);
        expect(r?.warnings.join(" ")).toContain("no such run dir or file");
    });
});
describe("probe parser — span pairing", () => {
    test("tool_call↔tool_result and llm_request↔llm_usage share spanId; events sort by seq", () => {
        const dir = tmp("probe-span-");
        const f = join(dir, "inst-1.0.jsonl");
        // Write deliberately OUT of seq order to prove stable seq sort.
        const events = buildFailing();
        writeFileSync(f, toJsonl([...events].reverse()));
        const { events: parsed } = loadTrajectory(f);
        for (let i = 1; i < parsed.length; i++) {
            expect(parsed[i].seq).toBeGreaterThanOrEqual(parsed[i - 1].seq);
        }
        const call = parsed.find((e) => e.kind === "tool_call" && e.data.name === "bash");
        const result = parsed.find((e) => e.kind === "tool_result" && e.data.name === "bash");
        expect(call?.spanId).toBeDefined();
        expect(result?.spanId).toBe(call?.spanId);
        const req = parsed.find((e) => e.kind === "llm_request");
        const usage = parsed.find((e) => e.kind === "llm_usage");
        expect(usage?.spanId).toBe(req?.spanId);
    });
});
// Wording that would assert a definitive cause. "NON-authoritative" and
// "verdict-free" are explicit DISCLAIMERS, so they are excluded — the contract
// forbids *claiming* authority, not actively renouncing it.
const NON_AUTHORITATIVE_FORBIDDEN = [
    /\bthe cause\b/i,
    /\bdefinitive\b/i,
    /\bcertain(ly)?\b/i,
    /(?<!-)\bverdict\b(?!-free)/i,
    /\bproven\b/i,
    /\bguaranteed\b/i,
    /(?<!non[-\s])\bauthoritative\b/i,
];
describe("triage — bounded confidence + NON-authoritative contract (RFC §3.8)", () => {
    const cases = [
        { name: "verify_failed", events: buildFailing() },
        {
            name: "patch_rejected",
            events: [
                ev("session_start", {}),
                ev("patch_rejected", {
                    diffPath: "/tmp/p",
                    filesChanged: 0,
                    hunks: 0,
                    applyStatus: "conflict",
                }),
                ev("session_end", { reason: "done" }),
            ],
        },
        {
            name: "max_turns",
            events: [ev("session_start", {}), ev("session_end", { reason: "max_turns", turns: 30 })],
        },
        {
            name: "aborted",
            events: [ev("session_start", {}), ev("session_end", { reason: "aborted by signal" })],
        },
        {
            name: "tool_error_loop",
            events: [
                ev("tool_result", {
                    name: "bash",
                    ok: false,
                    durationMs: 1,
                    stdoutTail: "x",
                    stderrTail: "e",
                }),
                ev("tool_result", {
                    name: "bash",
                    ok: false,
                    durationMs: 1,
                    stdoutTail: "x",
                    stderrTail: "e",
                }),
                ev("tool_result", {
                    name: "bash",
                    ok: false,
                    durationMs: 1,
                    stdoutTail: "x",
                    stderrTail: "e",
                }),
            ],
        },
        {
            name: "llm_error",
            events: [ev("session_start", {}), ev("error", { message: "rate limited" })],
        },
        {
            name: "no_patch",
            events: [
                ev("session_start", {}),
                ev("turn_start", { turn: 0 }),
                ev("session_end", { reason: "stop" }),
            ],
        },
        { name: "unknown/empty", events: [] },
    ];
    for (const c of cases) {
        test(`${c.name}: confidence ∈ [0,1] and never above the 0.9 cap`, () => {
            const t = triage(c.events);
            expect(t.confidence).toBeGreaterThanOrEqual(0);
            expect(t.confidence).toBeLessThanOrEqual(1);
            expect(t.confidence).toBeLessThanOrEqual(0.9);
            // Non-authoritative shape: a hint + at least one raw evidence line.
            expect(typeof t.triage_hint).toBe("string");
            expect(t.triage_hint.length).toBeGreaterThan(0);
            expect(t.evidence.length).toBeGreaterThan(0);
        });
        test(`${c.name}: no authoritative / verdict wording in hint or evidence`, () => {
            const t = triage(c.events);
            const blob = [t.triage_hint, ...t.evidence].join(" \n ");
            for (const re of NON_AUTHORITATIVE_FORBIDDEN) {
                expect(blob).not.toMatch(re);
            }
            // It IS hedged: the hint hedges with likely/suggest/appear/not-match.
            expect(t.triage_hint).toMatch(/likely|suggest|appear|hypothesis|may have|does not match/i);
        });
    }
    test("classification is deterministic and priority-ordered (verify wins over no_patch)", () => {
        const e = buildFailing(); // has verify-failed AND a patch
        expect(triage(e).likely_failure_class).toBe("verify_failed");
        expect(triage(e)).toEqual(triage(buildFailing()));
    });
});
describe("render — hotspots ordered by duration; cost stamps pricingVersion", () => {
    test("hotspots are sorted slowest-first (derived from tool_result only)", () => {
        const out = renderHotspots(buildFailing());
        const bashIdx = out.indexOf("tool bash");
        const editIdx = out.indexOf("tool edit");
        // bash = 1200ms must appear before edit = 50ms.
        expect(bashIdx).toBeGreaterThanOrEqual(0);
        expect(editIdx).toBeGreaterThan(bashIdx);
    });
    test("renderCost stamps the pricing version and shows n/a for an unknown model", () => {
        seq = 0;
        const events = [
            ev("llm_usage", {
                model: "totally-unknown-model",
                inputTokens: 10,
                outputTokens: 5,
                costUsd: null,
            }),
        ];
        const dir = tmp("probe-cost-");
        const f = join(dir, "inst-x.0.jsonl");
        writeFileSync(f, toJsonl(events));
        const run = loadRun(f);
        const out = renderCost(run.instances);
        expect(out).toContain("pricingVersion=pricing.v2");
        expect(out).toContain("n/a"); // unknown model ⇒ null ⇒ n/a, not a crash
    });
    test("renderTimeline degrades cleanly on no events", () => {
        expect(renderTimeline([])).toBe("(no events)");
    });
});
describe("probe CLI — end-to-end over a synthetic run dir", () => {
    const setupRun = () => {
        const dir = tmp("probe-run-");
        writeFileSync(join(dir, "inst-1.0.jsonl"), toJsonl(buildFailing()));
        return { dir };
    };
    const capture = async (argv) => {
        const chunks = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((s) => {
            chunks.push(typeof s === "string" ? s : String(s));
            return true;
        });
        try {
            const code = await main(argv);
            return { code, out: chunks.join("") };
        }
        finally {
            process.stdout.write = orig;
        }
    };
    test("missing argument is a usage error (exit 1), not a crash", async () => {
        const { code } = await capture([]);
        expect(code).toBe(1);
    });
    test("default render produces a timeline and exits 0", async () => {
        const { dir } = setupRun();
        const { code, out } = await capture([dir]);
        expect(code).toBe(0);
        // A single-instance, summary-less dir renders the per-turn timeline.
        expect(out).toContain("turn 0");
        expect(out).toContain("tool bash");
        expect(out).toContain("end: reason=completed");
    });
    test("--failed surfaces a hedged hypothesis WITH raw evidence, no verdict wording", async () => {
        const { dir } = setupRun();
        const { code, out } = await capture([dir, "--failed"]);
        expect(code).toBe(0);
        expect(out).toMatch(/NON-authoritative|hypothes/i);
        expect(out).toContain("likely=");
        expect(out).toContain("confidence");
        expect(out).toContain("evidence:");
        // Raw evidence from the verify event must travel with the hypothesis.
        expect(out).toContain("reportPath");
        for (const re of NON_AUTHORITATIVE_FORBIDDEN) {
            expect(out).not.toMatch(re);
        }
    });
    test("--json is stable, machine-shaped, and self-labels as a hypothesis", async () => {
        const { dir } = setupRun();
        const { code, out } = await capture([dir, "--failed", "--json"]);
        expect(code).toBe(0);
        const parsed = JSON.parse(out);
        expect(parsed.cost.pricingVersion).toBe("pricing.v2");
        expect(parsed.instances[0]?.instanceId).toBe("inst-1");
        const hyp = parsed.instances[0]?.triage_hypothesis;
        expect(hyp).toBeDefined();
        expect(hyp?.confidence).toBeGreaterThanOrEqual(0);
        expect(hyp?.confidence).toBeLessThanOrEqual(1);
        // The machine field is named *_hypothesis — never "cause"/"verdict".
        expect(Object.keys(parsed.instances[0] ?? {})).not.toContain("cause");
        expect(Object.keys(parsed.instances[0] ?? {})).not.toContain("verdict");
        for (const re of NON_AUTHORITATIVE_FORBIDDEN) {
            expect(out).not.toMatch(re);
        }
    });
    test("--instance filters to the matching id only", async () => {
        const { dir } = setupRun();
        const hit = await capture([dir, "--instance", "inst-1"]);
        expect(hit.code).toBe(0);
        // Single-instance dir ⇒ timeline render; the matching attempt is shown.
        expect(hit.out).toContain("turn 0");
        // An unknown id is not a crash: it degrades gracefully, exit 0.
        const miss = await capture([dir, "--instance", "does-not-exist"]);
        expect(miss.code).toBe(0);
    });
    test("--slow renders hotspots; --cost stamps pricingVersion", async () => {
        const { dir } = setupRun();
        const slow = await capture([dir, "--slow"]);
        expect(slow.code).toBe(0);
        expect(slow.out).toContain("tool bash");
        const cost = await capture([dir, "--cost"]);
        expect(cost.code).toBe(0);
        expect(cost.out).toContain("pricing.v2");
    });
});
