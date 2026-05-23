/**
 * Synthetic scenario runner. Materialises a scenario into a sandbox copy,
 * wires `runAgent` with a recording stream + optional JSONL recorder, and
 * returns the captured trajectory data the judge needs.
 *
 * Trajectory persistence (`recordTo`): when set, the run is teed to a real
 * `JsonlRecorder(strict:true)` AND a sibling `<jsonl>.meta.json` sidecar
 * (`trajectory/meta.ts`) so the file is replayable by Tier 3. We do NOT
 * persist trajectories by default — Tier 1 callers pass `recordTo` when they
 * want the artefact (the default `evals/runs/<runId>/` path is the convention).
 *
 * Sandbox safety: a fresh `mkdtemp`, scenario `files` written before run,
 * `setupCmd` failure aborts to verdict `error`, and any tool input matching
 * `scenario.forbidden` triggers a `forbiddenHit` (deterministic post-check —
 * the agent is NOT pre-empted, so we still get a faithful trajectory).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { buildSystemPrompt, runAgent } from "@/agent";
import { costUsd } from "@/observability/pricing";
import { errMessage, logger } from "@/shared";
import { JsonlRecorder, TeeStream } from "@/stream";
import { buildDefaultTools, ToolRegistry } from "@/tool";
import { writeMeta } from "../trajectory/meta";
/** Recording stream — keeps events in memory and tracks tool call inputs so
 *  the runner can post-check forbidden substrings without re-parsing JSONL. */
class CapturingStream {
    events = [];
    toolCalls = [];
    emit(event) {
        this.events.push(event);
        if (event.type === "tool_call") {
            this.toolCalls.push({ name: event.name, input: event.input });
        }
    }
    /** Sum every `{type:"usage"}` AgentEvent the agent loop emitted over the run
     *  (the loop fans one per `llm_usage` provider event via `emitUsage`). Returns
     *  the raw token totals; the caller decides whether to omit a zero-token run.
     *  Pure read over `events` — no side effects. */
    sumUsage() {
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        for (const e of this.events) {
            if (e.type !== "usage")
                continue;
            inputTokens += e.inputTokens;
            outputTokens += e.outputTokens;
            cacheReadTokens += e.cacheReadTokens ?? 0;
        }
        return { inputTokens, outputTokens, cacheReadTokens };
    }
}
/** Documented tuning knobs — extracted so a regression test pins them and a
 *  caller can override per-scenario without sprinkling magic numbers. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_SETUP_TIMEOUT_MS = 30_000;
/** Default max agent turns. 8 covers most 3-4 turn fixes plus 2-3 retries
 *  for tool failure / clarification. Increase per-scenario when the task
 *  legitimately needs more turns (e.g. multi-file refactor). */
export const DEFAULT_MAX_TURNS = 8;
/** Best-effort cleanup; never throws. */
const safeRm = async (path) => {
    try {
        await rm(path, { recursive: true, force: true });
    }
    catch (e) {
        logger.warn("eval.synthetic: sandbox cleanup failed", {
            path,
            error: errMessage(e),
        });
    }
};
/** True when `dest` lies inside (or is) `sandbox`. Uses `path.relative` so the
 *  check is portable (BSD/macOS/Linux/Windows) — string `startsWith('/')` was
 *  POSIX-only and silently let `..\evil` through on Windows. */
const isInsideSandbox = (sandbox, dest) => {
    if (dest === sandbox)
        return true;
    const rel = relative(sandbox, dest);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
};
/** Materialise scenario files into the sandbox root. Refuses paths escaping the root. */
const writeFiles = (sandbox, files) => {
    if (files === undefined)
        return;
    for (const f of files) {
        const dest = resolve(sandbox, f.path);
        if (!isInsideSandbox(sandbox, dest)) {
            throw new Error(`scenario file path escapes sandbox: ${f.path}`);
        }
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.content);
    }
};
const buildStream = (capture, recordTo, ctx) => {
    if (recordTo === undefined)
        return capture;
    // `strict:true` so a recorder failure surfaces as an exception (the same
    // posture bench uses for evaluable runs). Producer name distinguishes
    // eval-produced trajectories from regular agent runs in `producersOf`.
    const jsonl = new JsonlRecorder(recordTo, {
        ctx,
        strict: true,
        producer: { name: "eval.synthetic", version: "1" },
    });
    return new TeeStream([capture, jsonl]);
};
/** Run scenario against `runAgent`, returning capture for the judge. The
 *  sandbox is created and torn down here; callers do not need to cleanup. */
export const runScenario = async (scenario, opts) => {
    const start = Date.now();
    const sandbox = await mkdtemp(join(tmpdir(), "quanta-eval-"));
    try {
        writeFiles(sandbox, scenario.files);
        if (scenario.setupCmd !== undefined) {
            const r = spawnSync("sh", ["-c", scenario.setupCmd], {
                cwd: sandbox,
                encoding: "utf8",
                timeout: DEFAULT_SETUP_TIMEOUT_MS,
            });
            if (r.status !== 0) {
                throw new Error(`setupCmd failed (exit ${r.status}): ${(r.stderr ?? "").slice(0, 200)}`);
            }
        }
        const capture = new CapturingStream();
        // Cryptographic suffix on the recorder ctx prevents two scenarios with
        // the same `id` started in the same millisecond (Tier 4 parallel
        // adapters) from collisioning on `RunContext.runId` — which would
        // corrupt any recorder that keys span ids off the run id.
        const ctx = {
            runId: `synth-${scenario.id}-${Date.now()}-${randomBytes(3).toString("hex")}`,
        };
        const stream = buildStream(capture, opts.recordTo, ctx);
        // Sandbox: `bypass` mode skips HITL — we're in a throwaway tmp dir, and the
        // scenario `forbidden` list is the safety net for destructive commands.
        const permission = { mode: "bypass" };
        const messages = [
            { role: "user", content: [{ type: "text", text: scenario.prompt }] },
        ];
        const controller = new AbortController();
        const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
        // Track timeout-fired separately so we can override `stopReason` — relying
        // on `runAgent`'s `outcome.reason` alone would silently produce a normal
        // verdict when the wall-clock budget cut the run short.
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        let stopReason = "completed";
        let turns = 0;
        try {
            const outcome = await runAgent({
                llm: opts.llm,
                // DIP factory: synthetic scenarios run against the default port surface;
                // sandbox confinement comes from the tmp-dir cwd + `forbidden` matcher,
                // not from substituting fs ports here.
                registry: new ToolRegistry(buildDefaultTools()),
                stream,
                permission,
                messages,
                system: buildSystemPrompt(sandbox),
                cwd: sandbox,
                maxTurns: opts.maxTurns ?? scenario.maxTurns ?? DEFAULT_MAX_TURNS,
                signal: controller.signal,
            });
            stopReason = timedOut ? "timeout" : outcome.reason;
            turns = outcome.turns;
        }
        finally {
            clearTimeout(timer);
        }
        if (opts.recordTo !== undefined) {
            const meta = {
                schema: 1,
                userPrompt: scenario.prompt,
                cwd: sandbox,
                ...(opts.llm.model !== undefined ? { model: opts.llm.model } : {}),
                scenarioId: scenario.id,
                usecase: scenario.usecase,
                producer: { name: "eval.synthetic", version: "1" },
                recordedAt: new Date().toISOString(),
            };
            writeMeta(opts.recordTo, meta);
        }
        // ADR-0087 — token + cost rollup (see `rollupTokenCost`). Returns a
        // ready-to-spread object: absent fields when there's no usage / no price, so
        // the payload is byte-identical to the pre-feature path. Model id comes from
        // the run's LLM port (the same string baked into the meta sidecar above).
        const tokenCost = rollupTokenCost(capture, opts.llm.model);
        const forbiddenHit = detectForbidden(capture.toolCalls, scenario.forbidden);
        // Filter then guard the delta type: an `assistant_text` event with a
        // missing/non-string delta would join to the literal string "undefined"
        // and quietly contaminate the transcript handed to the judge.
        const assistantText = capture.events
            .filter((e) => e.type === "assistant_text")
            .map((e) => (typeof e.delta === "string" ? e.delta : ""))
            .join("");
        return {
            sandbox,
            assistantText,
            toolsUsed: capture.toolCalls.map((c) => c.name),
            ...(forbiddenHit !== undefined ? { forbiddenHit } : {}),
            turns,
            durationMs: Date.now() - start,
            stopReason,
            events: capture.events,
            ...(opts.recordTo !== undefined ? { trajectoryPath: opts.recordTo } : {}),
            ...tokenCost,
        };
    }
    finally {
        await safeRm(sandbox);
    }
};
/** ADR-0087 — derive a ready-to-spread `{tokens?, costUsd?}` slice from the
 *  captured `usage` events. A zero-token run (no usage events, e.g. a
 *  non-streaming mock or an aborted start) returns `{}` so the payload is
 *  byte-identical to the pre-feature path. `costUsd` is `null` for a run whose
 *  `model` is absent from the price table, and OMITTED when there's no usage OR
 *  no model id at all. */
const rollupTokenCost = (capture, model) => {
    const usage = capture.sumUsage();
    const hasUsage = usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0;
    if (!hasUsage)
        return {};
    const tokens = {
        prompt: usage.inputTokens,
        completion: usage.outputTokens,
        ...(usage.cacheReadTokens > 0 ? { cacheRead: usage.cacheReadTokens } : {}),
    };
    if (model === undefined)
        return { tokens };
    return {
        tokens,
        costUsd: costUsd(model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens),
    };
};
const detectForbidden = (calls, forbidden) => {
    if (forbidden === undefined || forbidden.length === 0)
        return undefined;
    for (const call of calls) {
        const serial = JSON.stringify(call.input);
        for (const needle of forbidden) {
            if (serial.includes(needle))
                return needle;
        }
    }
    return undefined;
};
