/**
 * ADR-0078 integration: secret redaction at the 3 mandatory points.
 *   1. tool result (model-facing) — when the `read` tool returns a file's
 *      contents containing an `AKIA...` key, the model-facing tool_result
 *      block MUST carry the placeholder, not the secret. Path-level Layer-1
 *      classification (`~/.env` ⇒ "secret") replaces the ENTIRE output.
 *   2. JSONL envelope — the snapshot handed to `persistSession` has every
 *      text/tool_result block run through `envelope_jsonl` redaction
 *      BEFORE crossing the persistence boundary.
 *   3. memory distill — the serialized transcript passed to the distiller
 *      MUST be redacted (a fake LLM records what it sees).
 *
 * The 4th surface — `outcome.redactions[]` — is asserted on each path:
 * the rollup carries `origin × kind` counts of every hit that fired.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "@/agent";
import { defaultTools, ToolRegistry } from "@/tool";
import { baseConfig, FakeLLM, RecordingStream, text, toolUse } from "./_harness";
const FAKE_SECRET = "AKIAIOSFODNN7EXAMPLE";
describe("ADR-0078 — three application points", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "quanta-redact-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    test("point 1: tool_result redaction replaces format-shaped secrets in the model-facing block", async () => {
        // A non-secret path so Layer-1 doesn't short-circuit — Layer-2 format
        // regex must do the work.
        const file = join(dir, "data.txt");
        writeFileSync(file, `prefix\nkey=${FAKE_SECRET}\nsuffix`);
        const llm = new FakeLLM([
            toolUse("c1", "read", { path: file }),
            text("done"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent(baseConfig({
            llm,
            registry,
            stream,
            cwd: dir,
            permission: { mode: "acceptEdits" },
            system: "test",
        }));
        expect(outcome.reason).toBe("completed");
        // The tool_result EMITTED on the stream carries the redacted preview.
        const toolResults = stream.events.filter((e) => e.type === "tool_result");
        expect(toolResults.length).toBeGreaterThan(0);
        const previewText = toolResults
            .map((e) => (e.type === "tool_result" ? e.preview : ""))
            .join("\n");
        expect(previewText).not.toContain(FAKE_SECRET);
        expect(previewText).toContain("[REDACTED:aws_access_key_id]");
        // Rollup carries the count.
        expect(outcome.redactions).toBeDefined();
        const toolHit = outcome.redactions?.find((r) => r.origin === "tool_result" && r.kind === "aws_access_key_id");
        expect(toolHit?.count ?? 0).toBeGreaterThan(0);
    });
    test("point 1: source-class secret path (.env) replaces entire tool output", async () => {
        const envFile = join(dir, ".env");
        writeFileSync(envFile, `STRIPE=sk_live_${"X".repeat(32)}\nDEBUG=true`);
        const llm = new FakeLLM([
            toolUse("c1", "read", { path: envFile }),
            text("done"),
        ]);
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent(baseConfig({
            llm,
            registry,
            stream,
            cwd: dir,
            permission: { mode: "acceptEdits" },
            system: "test",
        }));
        expect(outcome.reason).toBe("completed");
        const toolResults = stream.events.filter((e) => e.type === "tool_result");
        const previewText = toolResults
            .map((e) => (e.type === "tool_result" ? e.preview : ""))
            .join("\n");
        expect(previewText).toContain("[REDACTED:source_class_secret]");
        expect(previewText).toContain("origin:");
        expect(previewText).not.toContain("sk_live_");
        expect(previewText).not.toContain("DEBUG=true"); // ENTIRE output replaced
        const rollup = outcome.redactions?.find((r) => r.origin === "tool_result" && r.kind === "source_class_secret");
        expect(rollup?.count ?? 0).toBeGreaterThan(0);
    });
    test("point 3: memory_distill input is redacted before the distill LLM call", async () => {
        // Single LLM that serves both the main turn AND the distill turn at
        // session end. We capture every `stream()` input so we can inspect
        // what the distiller saw.
        const seen = [];
        class CapturingLLM {
            model = "capturing";
            calls = 0;
            async *stream(input) {
                const collected = input.messages
                    .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
                    .join("\n");
                seen.push(collected);
                this.calls += 1;
                // First call is the main turn — leak a secret in assistant text.
                // Subsequent calls (distill) yield empty JSON array.
                if (this.calls === 1) {
                    yield { type: "text_delta", delta: `Here is the leaked key: ${FAKE_SECRET}` };
                    yield { type: "message_stop", stop_reason: "end_turn" };
                    return;
                }
                yield { type: "text_delta", delta: "[]" };
                yield { type: "message_stop", stop_reason: "end_turn" };
            }
        }
        const llm = new CapturingLLM();
        // Minimal PersistentStorePort stub — drives the distill path.
        const store = {
            async append() { },
            async update() { },
            async list() {
                return [];
            },
            async remove() { },
            async get() {
                return null;
            },
        };
        const stream = new RecordingStream();
        const registry = new ToolRegistry(defaultTools);
        const outcome = await runAgent(baseConfig({
            llm,
            registry,
            stream,
            cwd: dir,
            permission: { mode: "acceptEdits" },
            system: "test",
            // biome-ignore lint/suspicious/noExplicitAny: minimal store stub
            store: store,
            memory: { distill: true },
        }));
        expect(outcome.reason).toBe("completed");
        // The distill call (the SECOND `stream()` invocation) saw a redacted
        // transcript — never the raw secret.
        expect(llm.calls).toBeGreaterThanOrEqual(2);
        const distilledInput = seen[1] ?? "";
        expect(distilledInput).not.toContain(FAKE_SECRET);
        expect(distilledInput).toContain("[REDACTED:aws_access_key_id]");
        // Rollup carries the memory_distill origin.
        const distillRollup = outcome.redactions?.find((r) => r.origin === "memory_distill" && r.kind === "aws_access_key_id");
        expect(distillRollup?.count ?? 0).toBeGreaterThan(0);
    });
    test("envelope_jsonl rollup fires when the persisted snapshot contains a secret", async () => {
        // Construct a snapshot scenario that drives `persistSession` (so the
        // envelope_jsonl redactor runs over the transcript) and verify the
        // rollup carries the `envelope_jsonl` origin.
        const store = {
            async append() { },
            async update() { },
            async list() {
                return [];
            },
            async remove() { },
            async get() {
                return null;
            },
        };
        const distillLLM = {
            model: "fake-distill",
            async *stream() {
                yield { type: "text_delta", delta: "[]" };
                yield { type: "message_stop", stop_reason: "end_turn" };
            },
        };
        const fakeMainLLM = new FakeLLM([
            text(`The token is sk-ant-${"X".repeat(40)} btw.`),
        ]);
        const outcome = await runAgent(baseConfig({
            llm: fakeMainLLM,
            registry: new ToolRegistry(defaultTools),
            stream: new RecordingStream(),
            cwd: dir,
            permission: { mode: "acceptEdits" },
            system: "test",
            // biome-ignore lint/suspicious/noExplicitAny: minimal store stub
            store: store,
        }));
        expect(outcome.reason).toBe("completed");
        const envelopeRollup = outcome.redactions?.find((r) => r.origin === "envelope_jsonl" && r.kind === "anthropic_api_key");
        expect(envelopeRollup?.count ?? 0).toBeGreaterThan(0);
    });
    test("opt-out without acknowledgedRisk throws startup error — refuses to start", async () => {
        await expect(runAgent(baseConfig({
            llm: new FakeLLM([text("ok")]),
            registry: new ToolRegistry(defaultTools),
            stream: new RecordingStream(),
            cwd: dir,
            permission: { mode: "acceptEdits" },
            system: "test",
            redaction: { disabled: true },
        }))).rejects.toThrow("Secret redaction disabled requires explicit acknowledgedRisk string. Refusing to start.");
    });
    test("opt-out WITH acknowledgedRisk → redaction OFF, model sees raw secret + system-reminder banner", async () => {
        const file = join(dir, "data.txt");
        writeFileSync(file, `key=${FAKE_SECRET}`);
        const llm = new FakeLLM([toolUse("c1", "read", { path: file }), text("done")]);
        const stream = new RecordingStream();
        const outcome = await runAgent(baseConfig({
            llm,
            registry: new ToolRegistry(defaultTools),
            stream,
            cwd: dir,
            permission: { mode: "acceptEdits" },
            system: "test",
            redaction: { disabled: true, acknowledgedRisk: "test fixture ack" },
        }));
        expect(outcome.reason).toBe("completed");
        // Raw secret is in the tool_result preview (redaction OFF).
        const previewText = stream.events
            .filter((e) => e.type === "tool_result")
            .map((e) => (e.type === "tool_result" ? e.preview : ""))
            .join("\n");
        expect(previewText).toContain(FAKE_SECRET);
        // The per-turn `<system-reminder>` includes the disabled banner.
        const turnReminders = llm.seenMessages
            .flat()
            .flatMap((m) => m.content)
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n");
        expect(turnReminders).toContain("Secret redaction DISABLED");
        expect(turnReminders).toContain("test fixture ack");
        // No `tool_result` rollup since redaction was off.
        expect(outcome.redactions).toBeUndefined();
    });
});
