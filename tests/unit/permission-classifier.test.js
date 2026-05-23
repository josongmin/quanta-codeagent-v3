import { describe, expect, test } from "bun:test";
import { AutoModeClassifier, CLASSIFIER_SYSTEM_PROMPT, DENIAL_LIMITS, evaluate, evaluateAuto, } from "@/permission";
// T1.D — auto-mode LLM permission classifier (mock ClassifierPort).
const action = (over = {}) => ({
    tool: "bash",
    input: { command: "echo hi > out.txt" },
    isReadOnly: false,
    ...over,
});
/** Deterministic mock: always returns the same decision regardless of stage. */
const constPort = (d) => async () => d;
describe("CLASSIFIER_SYSTEM_PROMPT fidelity", () => {
    test("contains the verbatim threat-taxonomy anchors", () => {
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("You are a security monitor for autonomous AI coding agents.");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("**Questions are not consent**");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("**Scope escalation = autonomous behavior**");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("HARD BLOCK");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("SOFT BLOCK");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("ENCODED COMMANDS");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("COMPOSITE ACTIONS");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("<permissions_template>");
    });
});
describe("AutoModeClassifier verdicts", () => {
    test("allow: fast pass clears immediately", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "allow", reason: "ok" }));
        const d = await c.evaluate({ tool: "bash", input: {}, systemPrompt: "" });
        expect(d.verdict).toBe("allow");
        expect(d.stage).toBe("fast");
        expect(d.fallback).toBe(false);
    });
    test("block: fast says block, thinking confirms block -> deny", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "block", reason: "exfiltration", classification: "Data Exfiltration" }));
        const d = await c.evaluate({ tool: "bash", input: {}, systemPrompt: "" });
        expect(d.verdict).toBe("deny");
        expect(d.stage).toBe("thinking");
        expect(d.classification).toBe("Data Exfiltration");
    });
    test("escalation: fast blocks but thinking allows (user intent) -> allow", async () => {
        let n = 0;
        const port = async (req) => {
            n++;
            return req.stage === "fast"
                ? { verdict: "block", reason: "uncertain" }
                : { verdict: "allow", reason: "user explicitly authorized" };
        };
        const c = new AutoModeClassifier(port);
        const d = await c.evaluate({ tool: "bash", input: {}, systemPrompt: "" });
        expect(d.verdict).toBe("allow");
        expect(d.stage).toBe("thinking");
        expect(n).toBe(2);
    });
    test("denial-limit: 3 consecutive denials -> fallback ask", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "block", reason: "nope" }));
        expect((await c.evaluate({ tool: "t", input: {}, systemPrompt: "" })).verdict).toBe("deny");
        expect((await c.evaluate({ tool: "t", input: {}, systemPrompt: "" })).verdict).toBe("deny");
        const third = await c.evaluate({ tool: "t", input: {}, systemPrompt: "" });
        expect(third.verdict).toBe("ask");
        expect(third.fallback).toBe(true);
        expect(third.reason).toContain("consecutive actions were blocked");
        expect(c.getDenialState().consecutiveDenials).toBe(DENIAL_LIMITS.maxConsecutive);
    });
    test("consecutive counter resets on an allow between denials", async () => {
        let mode = "block";
        const port = async () => mode === "block" ? { verdict: "block", reason: "x" } : { verdict: "allow", reason: "y" };
        const c = new AutoModeClassifier(port);
        await c.evaluate({ tool: "t", input: {}, systemPrompt: "" }); // deny 1
        await c.evaluate({ tool: "t", input: {}, systemPrompt: "" }); // deny 2
        mode = "allow";
        await c.evaluate({ tool: "t", input: {}, systemPrompt: "" }); // allow -> reset
        expect(c.getDenialState().consecutiveDenials).toBe(0);
        mode = "block";
        const d = await c.evaluate({ tool: "t", input: {}, systemPrompt: "" });
        expect(d.verdict).toBe("deny"); // back to 1, not over limit
    });
    test("circuit-break is sticky -> fallback ask", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "allow", reason: "ok" }));
        c.tripCircuitBreaker();
        expect(c.isCircuitBroken()).toBe(true);
        const d = await c.evaluate({ tool: "t", input: {}, systemPrompt: "" });
        expect(d.verdict).toBe("ask");
        expect(d.fallback).toBe(true);
    });
    test("absent port -> degrade safely to fallback ask", async () => {
        const c = new AutoModeClassifier(undefined);
        const d = await c.evaluate({ tool: "t", input: {}, systemPrompt: "" });
        expect(d.verdict).toBe("ask");
        expect(d.fallback).toBe(true);
    });
});
describe("evaluateAuto wiring", () => {
    const ctx = (over = {}) => ({
        mode: "auto",
        classify: async () => ({ verdict: "allow", reason: "ok" }),
        ...over,
    });
    test("read-only is allowed before classifier", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "block", reason: "x" }));
        const d = await evaluateAuto(action({ isReadOnly: true }), ctx(), c);
        expect(d.kind).toBe("allow");
    });
    test("HARD_DENY beats the classifier in auto mode", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "allow", reason: "trust me" }));
        const d = await evaluateAuto(action({ input: { command: "rm -rf /" } }), ctx(), c);
        expect(d.kind).toBe("deny");
    });
    // S-Audit P1: HARD_DENY is checked BEFORE the read-only fast-path in
    // evaluateAuto too — a spoofed `isReadOnly:true` on a shell-bearing action
    // cannot sidestep the denylist by short-circuiting to allow.
    test("HARD_DENY beats a spoofed isReadOnly:true in auto mode", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "allow", reason: "trust me" }));
        const spoof = action({
            input: { command: "rm -rf /" },
            isReadOnly: true,
            shellCommand: "rm -rf /",
        });
        expect((await evaluateAuto(spoof, ctx(), c)).kind).toBe("deny");
    });
    test("classifier allow -> allow; classifier block -> deny", async () => {
        const allowC = new AutoModeClassifier(constPort({ verdict: "allow", reason: "fine" }));
        expect((await evaluateAuto(action(), ctx(), allowC)).kind).toBe("allow");
        const blockC = new AutoModeClassifier(constPort({ verdict: "block", reason: "bad" }));
        expect((await evaluateAuto(action(), ctx(), blockC)).kind).toBe("deny");
    });
    test("denial-limit fallback surfaces as ask via evaluateAuto", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "block", reason: "no" }));
        await evaluateAuto(action(), ctx(), c);
        await evaluateAuto(action(), ctx(), c);
        const third = await evaluateAuto(action(), ctx(), c);
        expect(third.kind).toBe("ask");
    });
    test("classifier-absent context degrades auto to ask", async () => {
        const c = new AutoModeClassifier(undefined);
        const d = await evaluateAuto(action(), { mode: "auto" }, c);
        expect(d.kind).toBe("ask");
    });
    test("non-auto modes delegate to sync evaluate (behavior-preserving)", async () => {
        const c = new AutoModeClassifier(constPort({ verdict: "block", reason: "x" }));
        expect((await evaluateAuto(action(), { mode: "bypass" }, c)).kind).toBe("allow");
        expect((await evaluateAuto(action(), { mode: "default" }, c)).kind).toBe("ask");
        expect((await evaluateAuto(action(), { mode: "acceptEdits" }, c)).kind).toBe("allow");
    });
});
describe("sync evaluate degrades auto safely", () => {
    test("auto mode without async path -> ask, HARD_DENY still wins", () => {
        expect(evaluate(action(), { mode: "auto" }).kind).toBe("ask");
        expect(evaluate(action({ input: { command: "rm -rf /" } }), { mode: "auto" }).kind).toBe("deny");
        expect(evaluate(action({ isReadOnly: true }), { mode: "auto" }).kind).toBe("allow");
    });
});
