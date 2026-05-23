/**
 * Wave A integration test — admissibility-gate + ADR-0029 (Reviewer 3-tier) +
 * ADR-0031 (prefix-rule DSL) seam.
 *
 * Each describe block exercises ONE Wave A path against ONE option combo.
 * Together they assert:
 *   - The byte-identical bypass when every Wave A option is undefined.
 *   - All five rule-store outcomes (allow/deny/ask/no_match-fallthrough/
 *     no_match-strict-deny).
 *   - HARD_DENY beats every Wave A allow.
 *   - Reviewer dispatch on HITL `always-confirm` escalation (3 reviewer tiers
 *     × 8 outcome states subject to the invariant matrix).
 *   - Sticky precedence (priorDenials) replays the historical denial without
 *     calling the port.
 *   - Reviewer port methods missing ⇒ `ReviewerUnavailableError` propagates.
 *   - Injected `decidedAt` is the only source of timestamps.
 *
 * Spec source: this PR's task brief ("Wave A: admissibility-gate.ts에 Reviewer
 * 3-tier (Slice 2) + prefix_rule DSL (Slice 4) 결선").
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAdmissibilityGate, } from "@/agent/admissibility-gate";
import { OutcomeInvariantError, ReviewerUnavailableError, } from "@/permission";
import { RulesStore } from "@/rules";
import { ToolRegistry } from "@/tool";
// ─── Fixtures ─────────────────────────────────────────────────────────────
const bashSchema = z.object({ command: z.string() });
const makeTool = (name, opts = {}) => {
    const tool = {
        name,
        description: `${name} tool`,
        inputSchema: (opts.schema ?? z.object({})),
        isReadOnly: () => opts.readOnly ?? false,
        isConcurrencySafe: () => opts.readOnly ?? false,
        execute: async function* () {
            yield { type: "result", result: { ok: true, output: "ran" } };
        },
    };
    if (opts.hitlTier) {
        ;
        tool.hitlTier = opts.hitlTier;
    }
    if (opts.extractShellCommand) {
        ;
        tool.extractShellCommand = opts.extractShellCommand;
    }
    return tool;
};
const call = (name, input = {}, id = "c1") => ({
    type: "tool_use",
    id,
    name,
    input,
});
const cfg = (over = {}) => ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" },
    ...over,
});
const actionOf = (tool, input = {}) => {
    const a = {
        tool: tool.name,
        input,
        isReadOnly: tool.isReadOnly(),
    };
    const e = tool
        .extractShellCommand;
    if (e) {
        const cmd = e(input);
        if (cmd !== null)
            a.shellCommand = cmd;
    }
    return a;
};
const loadedStore = (lines, layer = "user") => {
    const s = new RulesStore();
    s.loadLayer(layer, lines, `${layer}.rules`);
    return s;
};
/** Builder for a `ReviewerPort` with scripted responses per tier. */
const makePort = (over = {}) => ({
    userReview: over.userReview ??
        (async () => {
            throw new Error("userReview not scripted");
        }),
    autoReview: over.autoReview ??
        (async () => {
            throw new Error("autoReview not scripted");
        }),
    guardianReview: over.guardianReview ??
        (async () => {
            throw new Error("guardianReview not scripted");
        }),
});
const decision = (reviewer, outcome, decidedAt = 12345) => ({
    reviewer,
    outcome,
    riskLevel: "medium",
    rationale: `${reviewer} rendered ${outcome}`,
    decidedAt,
});
// ─── 1. Byte-identical smoke (zero Wave A options) ────────────────────────
describe("Wave A: byte-identical bypass when no option supplied", () => {
    test("undefined wave → behaves exactly like legacy 5-arg call", async () => {
        const ro = makeTool("ro", { readOnly: true });
        const c = cfg({ registry: new ToolRegistry([ro]) });
        // legacy 5-arg call (no wave)
        const legacy = await runAdmissibilityGate(call("ro"), c, { mode: "default" }, actionOf(ro));
        // explicit undefined wave
        const explicit = await runAdmissibilityGate(call("ro"), c, { mode: "default" }, actionOf(ro), undefined, undefined);
        expect(legacy).toBeNull();
        expect(explicit).toBeNull();
    });
    test("empty wave object → byte-identical (no option asserted)", async () => {
        const ro = makeTool("ro", { readOnly: true });
        const c = cfg({ registry: new ToolRegistry([ro]) });
        const res = await runAdmissibilityGate(call("ro"), c, { mode: "default" }, actionOf(ro), undefined, {});
        expect(res).toBeNull();
    });
    test("empty wave object → mutating tool still asked via legacy onConfirm", async () => {
        const mut = makeTool("mut", { readOnly: false });
        let asked = false;
        const c = cfg({
            registry: new ToolRegistry([mut]),
            onConfirm: async () => {
                asked = true;
                return false;
            },
        });
        const res = await runAdmissibilityGate(call("mut"), c, { mode: "default" }, actionOf(mut), undefined, {});
        expect(asked).toBe(true);
        expect(res?.preview).toBe("declined");
    });
});
// ─── 2. RulesStore only ───────────────────────────────────────────────────
describe("Wave A: RulesStore-only paths", () => {
    const bash = makeTool("bash", {
        readOnly: false,
        schema: bashSchema,
        extractShellCommand: (input) => input.command,
    });
    test("rule allow → admit (skips HITL + mode policy)", async () => {
        const wave = {
            rulesStore: loadedStore("allow git status\n"),
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "default" },
            // No onConfirm wired — proves the rule bypassed the mode ask path.
        });
        const input = { command: "git status" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "default" }, actionOf(bash, input), undefined, wave);
        expect(res).toBeNull();
    });
    test("rule deny → terminal deny with rule_deny preview", async () => {
        const wave = {
            rulesStore: loadedStore("deny rm -rf\n"),
        };
        const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } });
        const input = { command: "rm -rf ./dist" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res).not.toBeNull();
        expect(res?.preview).toBe("rule_deny");
        expect(res?.block.content).toContain("Permission denied by rule");
        expect(res?.block.content).toContain("rm -rf");
    });
    test("rule ask without ReviewerPort → deny with rule_ask preview", async () => {
        const wave = {
            rulesStore: loadedStore("ask git push\n"),
        };
        const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } });
        const input = { command: "git push origin main" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res).not.toBeNull();
        expect(res?.preview).toBe("rule_ask");
        expect(res?.block.content).toContain("no ReviewerPort is wired");
    });
    test("rule no_match + default policy (fallthrough) → continue to legacy path", async () => {
        const wave = {
            rulesStore: loadedStore("allow git status\n"),
        };
        let asked = false;
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "default" },
            onConfirm: async () => {
                asked = true;
                return false;
            },
        });
        const input = { command: "npm run build" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "default" }, actionOf(bash, input), undefined, wave);
        // No rule fired → fallthrough → mode policy → onConfirm asked.
        expect(asked).toBe(true);
        expect(res?.preview).toBe("declined");
    });
    test("rule no_match + noMatchPolicy='fallthrough' explicit → same as default", async () => {
        const wave = {
            rulesStore: loadedStore("allow git status\n"),
            noMatchPolicy: "fallthrough",
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "bypass" },
        });
        const input = { command: "npm run build" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        // bypass admits since no rule matched and we fell through.
        expect(res).toBeNull();
    });
    test("rule no_match + noMatchPolicy='deny' → terminal default-deny", async () => {
        const wave = {
            rulesStore: loadedStore("allow git status\n"),
            noMatchPolicy: "deny",
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "bypass" }, // would have allowed legacy
        });
        const input = { command: "npm run build" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res?.preview).toBe("rule_no_match_deny");
        expect(res?.block.content).toContain("no rule matched");
    });
    test("3-layer precedence (project > user > system): project deny beats system allow", async () => {
        const store = new RulesStore();
        store.loadLayer("system", "allow npm run\n", "system.rules");
        store.loadLayer("project", "deny npm run build\n", "project.rules");
        const wave = { rulesStore: store };
        const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } });
        const input = { command: "npm run build" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res?.preview).toBe("rule_deny");
    });
    test("rule allow without shellCommand falls back to tool name match", async () => {
        const ro = makeTool("read_file", { readOnly: true });
        const wave = {
            rulesStore: loadedStore("allow read_file\n"),
        };
        const c = cfg({
            registry: new ToolRegistry([ro]),
            permission: { mode: "default" },
        });
        const res = await runAdmissibilityGate(call("read_file"), c, { mode: "default" }, actionOf(ro), undefined, wave);
        expect(res).toBeNull();
    });
});
// ─── 3. ReviewerPort only (HITL always-confirm escalation) ────────────────
describe("Wave A: ReviewerPort dispatch on HITL always-confirm", () => {
    const dangerous = makeTool("dangerous", {
        readOnly: false,
        hitlTier: () => "always-confirm",
    });
    // 3.A — admissible outcomes for each reviewer (admit path)
    test("reviewer=user, outcome=user_approved → admit", async () => {
        let callCount = 0;
        const port = makePort({
            userReview: async () => {
                callCount += 1;
                return decision("user", "user_approved");
            },
        });
        const wave = {
            reviewerPort: port,
            defaultReviewer: "user",
            decidedAt: () => 12345,
        };
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, wave);
        expect(res).toBeNull();
        expect(callCount).toBe(1);
    });
    test("reviewer=user, outcome=user_approved_for_session → admit", async () => {
        const port = makePort({
            userReview: async () => decision("user", "user_approved_for_session"),
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 });
        expect(res).toBeNull();
    });
    test("reviewer=user, outcome=not_needed → admit", async () => {
        const port = makePort({ userReview: async () => decision("user", "not_needed") });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 });
        expect(res).toBeNull();
    });
    test("reviewer=user, outcome=user_denied → terminal deny (reviewer_user tag)", async () => {
        const port = makePort({ userReview: async () => decision("user", "user_denied") });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 });
        expect(res?.preview).toBe("reviewer_user");
        expect(res?.block.content).toContain("User declined");
        expect(res?.block.content).toContain("rendered user_denied");
    });
    test("reviewer=user, outcome=user_aborted → terminal deny with handoff suffix", async () => {
        const port = makePort({ userReview: async () => decision("user", "user_aborted") });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 });
        expect(res?.preview).toBe("reviewer_user");
        expect(res?.block.content).toContain("User aborted");
        expect(res?.block.content).toContain("cannot proceed without explicit human takeover");
    });
    test("reviewer=auto_review, outcome=config_allowed → admit (reviewer_auto)", async () => {
        let called = false;
        const port = makePort({
            autoReview: async () => {
                called = true;
                return decision("auto_review", "config_allowed");
            },
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "auto_review", decidedAt: () => 1 });
        expect(called).toBe(true);
        expect(res).toBeNull();
    });
    test("reviewer=auto_review, outcome=not_needed → admit", async () => {
        const port = makePort({
            autoReview: async () => decision("auto_review", "not_needed"),
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "auto_review", decidedAt: () => 1 });
        expect(res).toBeNull();
    });
    test("reviewer=guardian_subagent, outcome=guardian_approved → admit", async () => {
        const port = makePort({
            guardianReview: async () => decision("guardian_subagent", "guardian_approved"),
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "guardian_subagent", decidedAt: () => 1 });
        expect(res).toBeNull();
    });
    test("reviewer=guardian_subagent, outcome=guardian_denied → deny (reviewer_guardian)", async () => {
        const port = makePort({
            guardianReview: async () => decision("guardian_subagent", "guardian_denied"),
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "guardian_subagent", decidedAt: () => 1 });
        expect(res?.preview).toBe("reviewer_guardian");
        expect(res?.block.content).toContain("Guardian denied");
    });
    test("defaultReviewer omitted → falls back to 'user'", async () => {
        let userCalled = false;
        let autoCalled = false;
        const port = makePort({
            userReview: async () => {
                userCalled = true;
                return decision("user", "user_approved");
            },
            autoReview: async () => {
                autoCalled = true;
                return decision("auto_review", "config_allowed");
            },
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port });
        expect(userCalled).toBe(true);
        expect(autoCalled).toBe(false);
        expect(res).toBeNull();
    });
    test("ReviewerPort method missing → ReviewerUnavailableError propagates", async () => {
        // port has only guardianReview wired but defaultReviewer asks for "auto_review"
        const partialPort = {
            guardianReview: async () => decision("guardian_subagent", "guardian_approved"),
        };
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        await expect(runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: partialPort, defaultReviewer: "auto_review", decidedAt: () => 1 })).rejects.toBeInstanceOf(ReviewerUnavailableError);
    });
    test("port throw propagates (no silent catch)", async () => {
        class CustomError extends Error {
        }
        const port = makePort({
            userReview: async () => {
                throw new CustomError("kaboom");
            },
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        await expect(runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 })).rejects.toBeInstanceOf(CustomError);
    });
    test("invariant violation (auto_review denying) surfaces OutcomeInvariantError", async () => {
        // auto_review CANNOT deny per the invariant matrix; the port returning
        // a guardian_denied for an auto_review tier triggers OutcomeInvariantError
        // inside reviewAction.
        const port = makePort({
            autoReview: async () => ({
                reviewer: "auto_review",
                outcome: "guardian_denied",
                riskLevel: "high",
                rationale: "violates matrix",
                decidedAt: 1,
            }),
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        await expect(runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "auto_review", decidedAt: () => 1 })).rejects.toBeInstanceOf(OutcomeInvariantError);
    });
    test("HITL pre-approval-ok tier does NOT trigger reviewer (only always-confirm does)", async () => {
        const pre = makeTool("pre", {
            readOnly: false,
            hitlTier: () => "pre-approval-ok",
        });
        let called = false;
        const port = makePort({
            userReview: async () => {
                called = true;
                return decision("user", "user_approved");
            },
        });
        const c = cfg({
            registry: new ToolRegistry([pre]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("pre"), c, { mode: "bypass" }, actionOf(pre), undefined, { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 1 });
        // pre-approval-ok falls through to mode policy → bypass admits.
        expect(called).toBe(false);
        expect(res).toBeNull();
    });
});
// ─── 4. RulesStore + ReviewerPort (rule ask → reviewer escalate) ──────────
describe("Wave A: rule 'ask' escalates to ReviewerPort", () => {
    const bash = makeTool("bash", {
        readOnly: false,
        schema: bashSchema,
        extractShellCommand: (input) => input.command,
    });
    test("rule ask + reviewer approves → admit (reviewer route observable via decided_by)", async () => {
        let invoked = false;
        const port = makePort({
            userReview: async () => {
                invoked = true;
                return decision("user", "user_approved");
            },
        });
        const wave = {
            rulesStore: loadedStore("ask git push\n"),
            reviewerPort: port,
            defaultReviewer: "user",
            decidedAt: () => 1,
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "default" },
        });
        const input = { command: "git push origin main" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "default" }, actionOf(bash, input), undefined, wave);
        expect(invoked).toBe(true);
        expect(res).toBeNull();
    });
    test("rule ask + reviewer denies → deny tagged reviewer_user", async () => {
        const port = makePort({
            userReview: async () => decision("user", "user_denied"),
        });
        const wave = {
            rulesStore: loadedStore("ask git push\n"),
            reviewerPort: port,
            defaultReviewer: "user",
            decidedAt: () => 1,
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "bypass" },
        });
        const input = { command: "git push" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res?.preview).toBe("reviewer_user");
        expect(res?.block.content).toContain("User declined");
        expect(res?.block.content).toContain("origin=rule");
    });
    test("rule ask + guardian denies → reviewer_guardian tag", async () => {
        const port = makePort({
            guardianReview: async () => decision("guardian_subagent", "guardian_denied"),
        });
        const wave = {
            rulesStore: loadedStore("ask git push\n"),
            reviewerPort: port,
            defaultReviewer: "guardian_subagent",
            decidedAt: () => 1,
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "bypass" },
        });
        const input = { command: "git push" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res?.preview).toBe("reviewer_guardian");
        expect(res?.block.content).toContain("origin=rule");
    });
    test("rule allow short-circuits BEFORE reviewer (reviewer never called)", async () => {
        let invoked = false;
        const port = makePort({
            userReview: async () => {
                invoked = true;
                return decision("user", "user_denied");
            },
        });
        const wave = {
            rulesStore: loadedStore("allow git status\n"),
            reviewerPort: port,
            defaultReviewer: "user",
            decidedAt: () => 1,
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "default" },
        });
        const input = { command: "git status" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "default" }, actionOf(bash, input), undefined, wave);
        expect(invoked).toBe(false);
        expect(res).toBeNull();
    });
    test("rule deny short-circuits BEFORE reviewer", async () => {
        let invoked = false;
        const port = makePort({
            userReview: async () => {
                invoked = true;
                return decision("user", "user_approved");
            },
        });
        const wave = {
            rulesStore: loadedStore("deny git push\n"),
            reviewerPort: port,
            defaultReviewer: "user",
            decidedAt: () => 1,
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "bypass" },
        });
        const input = { command: "git push" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(invoked).toBe(false);
        expect(res?.preview).toBe("rule_deny");
    });
});
// ─── 5. Sticky priorDenials precedence ────────────────────────────────────
describe("Wave A: priorDenials sticky precedence", () => {
    const dangerous = makeTool("dangerous", {
        readOnly: false,
        hitlTier: () => "always-confirm",
    });
    test("guardian_denied in priorDenials → blocks same actionKey without re-asking", async () => {
        let portCalled = false;
        const port = makePort({
            userReview: async () => {
                portCalled = true;
                return decision("user", "user_approved");
            },
        });
        const priorDenials = [
            {
                sessionId: "s1",
                actionKey: "dangerous",
                reviewer: "guardian_subagent",
                outcome: "guardian_denied",
                deniedAt: 9000,
            },
        ];
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, {
            reviewerPort: port,
            defaultReviewer: "user",
            priorDenials,
            decidedAt: () => 1,
        });
        expect(portCalled).toBe(false);
        expect(res?.preview).toBe("reviewer_guardian");
        expect(res?.block.content).toContain("Guardian denied");
    });
    test("user_aborted in priorDenials → terminator wins over guardian_denied", async () => {
        const priorDenials = [
            {
                sessionId: "s1",
                actionKey: "dangerous",
                reviewer: "guardian_subagent",
                outcome: "guardian_denied",
                deniedAt: 9000,
            },
            {
                sessionId: "s1",
                actionKey: "dangerous",
                reviewer: "user",
                outcome: "user_aborted",
                deniedAt: 9500,
            },
        ];
        const port = makePort({
            userReview: async () => decision("user", "user_approved"),
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, {
            reviewerPort: port,
            defaultReviewer: "user",
            priorDenials,
            decidedAt: () => 1,
        });
        expect(res?.preview).toBe("reviewer_user");
        expect(res?.block.content).toContain("User aborted");
    });
    test("priorDenials with DIFFERENT actionKey does NOT block (reviewer called)", async () => {
        let invoked = false;
        const port = makePort({
            userReview: async () => {
                invoked = true;
                return decision("user", "user_approved");
            },
        });
        const priorDenials = [
            {
                sessionId: "s1",
                actionKey: "OTHER_TOOL", // different key
                reviewer: "guardian_subagent",
                outcome: "guardian_denied",
                deniedAt: 9000,
            },
        ];
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, {
            reviewerPort: port,
            defaultReviewer: "user",
            priorDenials,
            decidedAt: () => 1,
        });
        expect(invoked).toBe(true);
        expect(res).toBeNull();
    });
    test("sticky precedence applies on RULE ASK path too (actionKey carries shellCommand)", async () => {
        const bash = makeTool("bash", {
            readOnly: false,
            schema: bashSchema,
            extractShellCommand: (input) => input.command,
        });
        let invoked = false;
        const port = makePort({
            userReview: async () => {
                invoked = true;
                return decision("user", "user_approved");
            },
        });
        const priorDenials = [
            {
                sessionId: "s1",
                actionKey: "bash|git push",
                reviewer: "guardian_subagent",
                outcome: "guardian_denied",
                deniedAt: 9000,
            },
        ];
        const wave = {
            rulesStore: loadedStore("ask git push\n"),
            reviewerPort: port,
            defaultReviewer: "user",
            priorDenials,
            decidedAt: () => 1,
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "bypass" },
        });
        const input = { command: "git push" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(invoked).toBe(false);
        expect(res?.preview).toBe("reviewer_guardian");
        expect(res?.block.content).toContain("origin=rule");
    });
});
// ─── 6. HARD_DENY beats every Wave A option ───────────────────────────────
describe("Wave A: HARD_DENY beats every option", () => {
    const bash = makeTool("bash", {
        readOnly: false,
        schema: bashSchema,
        extractShellCommand: (input) => input.command,
    });
    test("HARD_DENY beats rule allow (rule_allow CANNOT bypass denylist)", async () => {
        const wave = {
            rulesStore: loadedStore("allow rm\n"),
        };
        const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } });
        const input = { command: "rm -rf /" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res?.preview).toBe("handoff");
        expect(res?.block.content).toContain("human handoff");
        expect(res?.block.content).toContain("Blocked dangerous command");
    });
    test("HARD_DENY beats reviewer approval (port never called)", async () => {
        let invoked = false;
        const port = makePort({
            userReview: async () => {
                invoked = true;
                return decision("user", "user_approved");
            },
        });
        const wave = {
            reviewerPort: port,
            defaultReviewer: "user",
            decidedAt: () => 1,
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const input = { command: "rm -rf /" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(invoked).toBe(false);
        expect(res?.preview).toBe("handoff");
    });
    test("HARD_DENY beats rule deny (priority — denylist is the security boundary, not the rule)", async () => {
        // Both produce a deny, but HARD_DENY's "handoff" preview must win because
        // it carries the security-boundary semantics (no mode authorizes).
        const wave = {
            rulesStore: loadedStore("deny rm\n"),
        };
        const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } });
        const input = { command: "rm -rf /" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res?.preview).toBe("handoff");
    });
    test("HARD_DENY beats rule no_match strict deny too", async () => {
        const wave = {
            rulesStore: loadedStore("allow git status\n"),
            noMatchPolicy: "deny",
        };
        const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } });
        const input = { command: "rm -rf /" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res?.preview).toBe("handoff");
    });
    test("mode-block beats HARD_DENY (review mode short-circuits even bash rm)", async () => {
        // Mode-block runs FIRST in the gate; this asserts the canonical ordering
        // is unchanged by Wave A.
        const wave = {
            rulesStore: loadedStore("deny rm\n"),
        };
        const c = cfg({
            registry: new ToolRegistry([bash]),
            mode: "review",
            permission: { mode: "bypass" },
        });
        const input = { command: "rm -rf /" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, actionOf(bash, input), undefined, wave);
        expect(res?.preview).toBe("review-blocked");
    });
});
// ─── 7. Injected clock determinism ────────────────────────────────────────
describe("Wave A: injectable decidedAt clock", () => {
    const dangerous = makeTool("dangerous", {
        readOnly: false,
        hitlTier: () => "always-confirm",
    });
    test("port receives decidedAt from injected function (not Date.now)", async () => {
        let observed = -1;
        const port = makePort({
            userReview: async (_a, ctx) => {
                observed = ctx.decidedAt;
                return decision("user", "user_approved", ctx.decidedAt);
            },
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 424242 });
        expect(observed).toBe(424242);
    });
    test("decidedAt is called ONCE per gate invocation (deterministic value)", async () => {
        let calls = 0;
        const clock = () => {
            calls += 1;
            return 7;
        };
        const port = makePort({
            userReview: async () => decision("user", "user_approved", 7),
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "user", decidedAt: clock });
        expect(calls).toBe(1);
    });
    test("missing decidedAt falls back to Date.now (still admissible)", async () => {
        const port = makePort({
            userReview: async (_a, ctx) => decision("user", "user_approved", ctx.decidedAt),
        });
        const c = cfg({
            registry: new ToolRegistry([dangerous]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(dangerous), undefined, { reviewerPort: port, defaultReviewer: "user" });
        expect(res).toBeNull();
    });
});
// ─── 8. Combined option ordering ─────────────────────────────────────────
describe("Wave A: cross-cutting ordering and edge cases", () => {
    test("rule allow bypasses HITL handler (onConfirm not called)", async () => {
        let confirmed = false;
        const tool = makeTool("dangerous", {
            readOnly: false,
            hitlTier: () => "always-confirm",
        });
        const wave = {
            rulesStore: loadedStore("allow dangerous\n"),
        };
        const c = cfg({
            registry: new ToolRegistry([tool]),
            hitl: { enabled: true },
            onConfirm: async () => {
                confirmed = true;
                return false;
            },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool), undefined, wave);
        expect(confirmed).toBe(false);
        expect(res).toBeNull();
    });
    test("rule no_match + fallthrough + reviewerPort → legacy HITL path uses reviewer", async () => {
        const tool = makeTool("dangerous", {
            readOnly: false,
            hitlTier: () => "always-confirm",
        });
        let invoked = false;
        const port = makePort({
            userReview: async () => {
                invoked = true;
                return decision("user", "user_approved");
            },
        });
        const wave = {
            rulesStore: loadedStore("allow nothing-here\n"),
            reviewerPort: port,
            defaultReviewer: "user",
            decidedAt: () => 1,
        };
        const c = cfg({
            registry: new ToolRegistry([tool]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool), undefined, wave);
        expect(invoked).toBe(true);
        expect(res).toBeNull();
    });
    test("rule allow + pre_tool_use hook STILL runs (hook is the last word)", async () => {
        const bash = makeTool("bash", {
            readOnly: false,
            schema: bashSchema,
            extractShellCommand: (input) => input.command,
        });
        const wave = {
            rulesStore: loadedStore("allow git status\n"),
        };
        const { HookBus } = await import("@/agent");
        const hooks = new HookBus();
        let hookCount = 0;
        hooks.on("pre_tool_use", () => {
            hookCount += 1;
            return { deny: "policy says no" };
        });
        const c = cfg({
            registry: new ToolRegistry([bash]),
            hooks,
            permission: { mode: "default" },
        });
        const input = { command: "git status" };
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "default" }, actionOf(bash, input), undefined, wave);
        expect(hookCount).toBe(1);
        expect(res?.preview).toBe("hook-denied");
        expect(res?.block.content).toContain("policy says no");
    });
    test("RulesStore.match throw propagates (no silent catch)", async () => {
        class BoomStore {
            match(_) {
                throw new Error("rules-boom");
            }
        }
        const bash = makeTool("bash", {
            readOnly: false,
            schema: bashSchema,
            extractShellCommand: (input) => input.command,
        });
        const wave = {
            rulesStore: new BoomStore(),
        };
        const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "default" } });
        const input = { command: "git status" };
        await expect(runAdmissibilityGate(call("bash", input), c, { mode: "default" }, actionOf(bash, input), undefined, wave)).rejects.toThrow("rules-boom");
    });
    test("only priorDenials supplied (no port, no rules) → still byte-identical legacy", async () => {
        // priorDenials without a reviewerPort is inert (the gate never reaches
        // reviewAction). Wave A treats it as a no-op so the legacy mode path runs.
        const mut = makeTool("mut", { readOnly: false });
        const c = cfg({
            registry: new ToolRegistry([mut]),
            onConfirm: async () => true,
            permission: { mode: "default" },
        });
        const res = await runAdmissibilityGate(call("mut"), c, { mode: "default" }, actionOf(mut), undefined, {
            priorDenials: [
                {
                    sessionId: "s1",
                    actionKey: "mut",
                    reviewer: "guardian_subagent",
                    outcome: "guardian_denied",
                    deniedAt: 1,
                },
            ],
        });
        expect(res).toBeNull();
    });
    test("Wave A active but only noMatchPolicy set (no rulesStore) → bypassed; legacy continues", async () => {
        const mut = makeTool("mut", { readOnly: false });
        const c = cfg({
            registry: new ToolRegistry([mut]),
            permission: { mode: "bypass" },
        });
        const res = await runAdmissibilityGate(call("mut"), c, { mode: "bypass" }, actionOf(mut), undefined, { noMatchPolicy: "deny" });
        // No rules store ⇒ rule gate falls through; bypass admits.
        expect(res).toBeNull();
    });
});
