import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookBus, runAgent } from "@/agent";
import { Metrics } from "@/observability";
import { defaultTools, ToolRegistry } from "@/tool";
import { FakeLLM, baseConfig as harnessBaseConfig, RecordingStream, text as textScript, toolUse as toolUseScript, } from "./_harness";
// Local convenience wrapper preserving the original 5-arg ordering. The
// harness `baseConfig` defaults `maxTurns:5` while this file uses 10 — pin
// it explicitly here so per-test bodies stay byte-identical.
const baseConfig = (llm, registry, stream, cwd, permission) => harnessBaseConfig({
    llm,
    registry,
    stream,
    permission,
    cwd,
    maxTurns: 10,
    system: "test",
});
describe("agent feature wiring", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "agent-feat-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    test("control: default path (no features) unchanged — write then text completes", async () => {
        const file = join(dir, "ctrl.txt");
        const llm = new FakeLLM([
            toolUseScript("c1", "write", { path: file, content: "ok" }),
            textScript("done"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }));
        expect(outcome.reason).toBe("completed");
        expect(outcome.turns).toBe(2);
        expect(readFileSync(file, "utf8")).toBe("ok");
    });
    test("planMode blocks a mutating write but read works, then completes", async () => {
        const src = join(dir, "src.txt");
        const blocked = join(dir, "blocked.txt");
        writeFileSync(src, "payload");
        const llm = new FakeLLM([
            toolUseScript("w1", "write", { path: blocked, content: "nope" }),
            toolUseScript("r1", "read", { path: src }),
            textScript("here is the plan"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
            planMode: true,
        });
        expect(outcome.reason).toBe("completed");
        expect(existsSync(blocked)).toBe(false);
        const blocks = outcome.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
        // ADR-0036 L4: dispatch-seam guard pre-empts → surfaces
        // "blocked in plan collaboration mode" (typed-error message).
        const denied = blocks.find((b) => b.type === "tool_result" &&
            (b.content.includes("blocked in plan mode") ||
                b.content.includes("blocked in plan collaboration mode")));
        expect(denied).toBeDefined();
        if (denied?.type === "tool_result")
            expect(denied.is_error).toBe(true);
        const readOk = blocks.find((b) => b.type === "tool_result" && b.content.includes("payload"));
        expect(readOk).toBeDefined();
    });
    test("HookBus fires session_start/end + pre/post_tool_use in order", async () => {
        const file = join(dir, "h.txt");
        const llm = new FakeLLM([
            toolUseScript("c1", "write", { path: file, content: "x" }),
            textScript("done"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const seen = [];
        const bus = new HookBus();
        bus.on("session_start", () => {
            seen.push("session_start");
        });
        bus.on("turn_start", (e) => {
            seen.push(`turn_start:${e.turn}`);
        });
        bus.on("pre_tool_use", (e) => {
            seen.push(`pre:${e.name}`);
        });
        bus.on("post_tool_use", (e) => {
            seen.push(`post:${e.name}:${e.ok}`);
        });
        bus.on("session_end", (e) => {
            seen.push(`session_end:${e.reason}`);
        });
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }),
            hooks: bus,
        });
        expect(outcome.reason).toBe("completed");
        expect(seen[0]).toBe("session_start");
        expect(seen.at(-1)).toBe("session_end:completed");
        const preIdx = seen.indexOf("pre:write");
        const postIdx = seen.indexOf("post:write:true");
        expect(preIdx).toBeGreaterThanOrEqual(0);
        expect(preIdx).toBeLessThan(postIdx);
        expect(seen).toContain("turn_start:1");
    });
    test("pre_tool_use hook deny blocks the call (error tool_result, model recovers)", async () => {
        const file = join(dir, "denied.txt");
        const llm = new FakeLLM([
            toolUseScript("c1", "write", { path: file, content: "x" }),
            textScript("recovered"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const bus = new HookBus();
        bus.on("pre_tool_use", (e) => (e.name === "write" ? { deny: "policy" } : undefined));
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
            hooks: bus,
        });
        expect(outcome.reason).toBe("completed");
        expect(existsSync(file)).toBe(false);
        const denied = outcome.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result" && b.content.includes("Hook denied: policy")));
        expect(denied).toHaveLength(1);
    });
    test("workingState absent ⇒ update_working_state NOT available; loop byte-identical", async () => {
        const file = join(dir, "ws-off.txt");
        const llm = new FakeLLM([
            toolUseScript("u1", "update_working_state", { hypothesis: "x" }),
            textScript("done"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }));
        expect(outcome.reason).toBe("completed");
        // Default-OFF: the tool is unknown → dispatch returns a deny tool_result.
        const blocks = outcome.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
        const denied = blocks.find((b) => b.type === "tool_result" && b.content.includes("Unknown tool: update_working_state"));
        expect(denied).toBeDefined();
        expect(existsSync(file)).toBe(false);
    });
    test("workingState enabled ⇒ update_working_state present, mutates session state", async () => {
        const llm = new FakeLLM([
            toolUseScript("u1", "update_working_state", {
                ownerShortlist: [{ file: "src/a.ts", reason: "primary" }],
                hypothesis: "the dispatcher races",
            }),
            textScript("done"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }),
            workingState: { enabled: true },
        });
        expect(outcome.reason).toBe("completed");
        const tres = outcome.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
        const ok = tres.find((b) => b.type === "tool_result" &&
            !b.is_error &&
            b.content.includes("ownerShortlist") &&
            b.content.includes("owners=1"));
        expect(ok).toBeDefined();
    });
    test("metrics snapshot records turns + tool_calls counters", async () => {
        const file = join(dir, "m.txt");
        const llm = new FakeLLM([
            toolUseScript("c1", "write", { path: file, content: "x" }),
            textScript("done"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const metrics = new Metrics();
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }),
            metrics,
        });
        expect(outcome.reason).toBe("completed");
        const snap = metrics.snapshot();
        expect(snap.counters["agent.turns"]).toBe(2);
        expect(snap.counters["agent.tool_calls"]).toBe(1);
        expect(snap.counters["agent.tool_calls.write"]).toBe(1);
        expect(snap.counters["agent.stop_reason.completed"]).toBe(1);
        expect(snap.timers["agent.llm_stream"]?.count).toBe(2);
        expect(snap.timers["agent.tool_exec"]?.count).toBe(1);
    });
    // Phase 7: Skill trigger rules end-to-end (Codex `skills-audit.md` mirror).
    // The seed at session start must surface the discovered skill catalogue +
    // trigger rules in the per-turn `<system-reminder>` reminder tail, and the
    // skill-less path must remain byte-identical.
    test("config.skills ⇒ active-skills block appears in the per-turn reminder", async () => {
        const skillsDir = join(dir, "skills");
        mkdirSync(join(skillsDir, "review"), { recursive: true });
        writeFileSync(join(skillsDir, "review", "SKILL.md"), "---\nname: review\ndescription: Review a pull request\n---\nReview body.\n");
        const llm = new FakeLLM([textScript("ok")]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }),
            skills: { dir: skillsDir },
        });
        expect(outcome.reason).toBe("completed");
        // The reminder rides as the trailing user message every turn.
        const sent = llm.seenMessages[0] ?? [];
        const tail = sent[sent.length - 1];
        const text = tail?.content[0]?.type === "text" ? tail.content[0].text : "";
        expect(text).toContain("## Active skills");
        expect(text).toContain("- $review — Review a pull request");
        expect(text).toContain("Trigger rules:");
        expect(text).toContain("Progressive disclosure");
    });
    test("without config.skills ⇒ no active-skills block (byte-identical)", async () => {
        const llm = new FakeLLM([textScript("ok")]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }));
        expect(outcome.reason).toBe("completed");
        const sent = llm.seenMessages[0] ?? [];
        const tail = sent[sent.length - 1];
        const text = tail?.content[0]?.type === "text" ? tail.content[0].text : "";
        expect(text).not.toContain("## Active skills");
        expect(text).not.toContain("Trigger rules:");
    });
});
