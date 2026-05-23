/**
 * Tier 3 trajectory replay — re-execute a fixture session against the CURRENT
 * agent and compare event streams structurally.
 *
 * Pre-condition: the fixture has a `*.meta.json` sidecar with `userPrompt`.
 * Sessions without meta are refused with `verdict:"skipped"`. The sidecar's
 * declared `usecase` is VALIDATED against `taxonomy.leafById` — an unknown
 * leaf id (renamed/removed) ⇒ recorded under `"unclassified"` with a note so
 * the operator notices the fixture is stale, instead of silently storing it
 * under an invalid id that breaks matrix grouping.
 *
 * Timeout posture: when the wall-clock budget cuts the run short, the verdict
 * is `error` (not pass/partial/fail) — relying on `runAgent.outcome.reason`
 * alone would silently classify a timed-out run as a normal completion.
 *
 * Replay-trajectory output: written under the eval STORE directory, NOT next
 * to the source fixture. The prior behaviour (`<fixture>.replay.jsonl` sibling)
 * polluted source-controlled fixture dirs and overwrote priors on re-run.
 *
 * Diff semantics live in `./diff.ts`. We persist `matched` + `divergedEvents`
 * in `TrajectoryPayload.replay` so reports surface regressions at the
 * use-case granularity. The pass/partial/fail ladder is SCALED to the
 * original projection length (not a magic `<=2` cliff) so a 200-event
 * trajectory with 3 diverged events is correctly "partial" and a 5-event
 * one with 3 diverged is correctly "fail".
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildSystemPrompt, runAgent } from "@/agent";
import { errMessage, logger } from "@/shared";
import { JsonlRecorder, TeeStream } from "@/stream";
import { buildDefaultTools, ToolRegistry } from "@/tool";
import { DEFAULT_RUNS_DIR, makeRunId, ResultStore } from "../storage";
import { leafById } from "../taxonomy";
import { diffStreams } from "./diff";
import { loadSession } from "./source";
/** Capture+replay use the same in-memory stream type as `synthetic/runner`,
 *  but we keep the class local so a refactor of one does not change the other. */
class CapturingStream {
    events = [];
    emit(event) {
        this.events.push(event);
    }
}
/** Tuning constants — extracted so a regression test pins them. The verdict
 *  thresholds are documented in `verdictFromDiff` below; the timeout default
 *  is intentionally larger than `synthetic/runner.DEFAULT_RUN_TIMEOUT_MS`
 *  because a replay re-walks the same path with cold caches. */
export const DEFAULT_REPLAY_TIMEOUT_MS = 180_000;
export const DEFAULT_MIN_REPLAY_TURNS = 6;
/** Diverged-events ratio at which `partial` becomes `fail`. 10% is loose
 *  enough that a single tool-input shape change in a long trajectory is
 *  forgiven; tighten via the env var below if you want stricter replay. */
export const REPLAY_PARTIAL_RATIO = 0.1;
const safeRm = async (path) => {
    try {
        await rm(path, { recursive: true, force: true });
    }
    catch (e) {
        logger.warn("eval.replay: sandbox cleanup failed", {
            path,
            error: errMessage(e),
        });
    }
};
const fixtureIdOf = (path) => basename(path, ".jsonl");
const skippedResult = (runId, fixtureId, start, reason, originalTurns, verdict = "skipped") => {
    logger.warn("eval.replay: refused", { fixtureId, reason, verdict });
    return {
        runId,
        fixtureId,
        usecase: "unclassified",
        verdict,
        originalTurns,
        replayTurns: 0,
        durationMs: Date.now() - start,
        reason,
    };
};
/** Verdict ladder. `matched` → pass; few diverged events relative to original
 *  length → partial; otherwise fail. NEVER returns "pass" for an aborted /
 *  timed-out run — callers thread `timedOut`/`runFailed` separately. */
const verdictFromDiff = (diff) => {
    if (diff.matched)
        return "pass";
    const ratio = diff.divergedEvents / Math.max(diff.originalLength, 1);
    return ratio <= REPLAY_PARTIAL_RATIO ? "partial" : "fail";
};
/** Run ONE fixture and append a `TrajectoryPayload.replay` record. */
export const replayFixture = async (opts) => {
    const start = Date.now();
    const store = new ResultStore({
        ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    const runId = makeRunId("trajectory", opts.now);
    const fixtureId = fixtureIdOf(opts.fixture);
    let original;
    try {
        original = loadSession(opts.fixture);
    }
    catch (e) {
        const r = skippedResult(runId, fixtureId, start, `load_failed: ${errMessage(e)}`, 0);
        await persistResult(store, runId, opts.fixture, r);
        return r;
    }
    if (original.meta === null) {
        const reason = original.metaResult.kind === "malformed"
            ? `meta_malformed: ${original.metaResult.error}`
            : "no_meta_sidecar";
        const r = skippedResult(runId, fixtureId, start, reason, original.turns);
        await persistResult(store, runId, opts.fixture, r);
        return r;
    }
    // Validate the fixture's declared use case against the live taxonomy. A
    // renamed / removed leaf must not silently land in an invalid bucket.
    const declaredUsecase = original.meta.usecase;
    const usecase = typeof declaredUsecase === "string" && leafById(declaredUsecase) !== undefined
        ? declaredUsecase
        : "unclassified";
    // Write the replay trajectory under the eval store dir — never adjacent to
    // a checked-in fixture (would pollute the repo + overwrite priors).
    const replayDir = join(opts.storeDir ?? DEFAULT_RUNS_DIR, runId);
    mkdirSync(replayDir, { recursive: true });
    const replayJsonl = join(replayDir, `${fixtureId}.replay.jsonl`);
    const sandbox = await mkdtemp(join(tmpdir(), "quanta-replay-"));
    try {
        const capture = new CapturingStream();
        const ctx = {
            runId: `replay-${fixtureId}-${Date.now()}-${randomBytes(3).toString("hex")}`,
        };
        const stream = new TeeStream([
            capture,
            new JsonlRecorder(replayJsonl, {
                ctx,
                strict: true,
                producer: { name: "eval.replay", version: "1" },
            }),
        ]);
        const permission = { mode: "bypass" };
        const messages = [
            { role: "user", content: [{ type: "text", text: original.meta.userPrompt }] },
        ];
        const controller = new AbortController();
        const timeoutMs = opts.timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        let replayTurns = 0;
        let runError;
        try {
            const outcome = await runAgent({
                llm: opts.llm,
                // DIP factory: trajectory replay runs against the SAME default port
                // surface as production (no replay-specific fs/diagnostics ports),
                // byte-identical to the prior singleton.
                registry: new ToolRegistry(buildDefaultTools()),
                stream,
                permission,
                messages,
                system: buildSystemPrompt(sandbox),
                cwd: sandbox,
                maxTurns: opts.maxTurns ?? Math.max(original.turns + 2, DEFAULT_MIN_REPLAY_TURNS),
                signal: controller.signal,
            });
            replayTurns = outcome.turns;
            if (outcome.reason === "error")
                runError = "runAgent reported error";
        }
        catch (e) {
            runError = errMessage(e);
        }
        finally {
            clearTimeout(timer);
        }
        if (timedOut) {
            const r = {
                runId,
                fixtureId,
                usecase,
                verdict: "error",
                originalTurns: original.turns,
                replayTurns,
                durationMs: Date.now() - start,
                reason: `timeout after ${timeoutMs}ms`,
            };
            await persistResult(store, runId, opts.fixture, r);
            return r;
        }
        if (runError !== undefined) {
            const r = {
                runId,
                fixtureId,
                usecase,
                verdict: "error",
                originalTurns: original.turns,
                replayTurns,
                durationMs: Date.now() - start,
                reason: `runAgent: ${runError}`,
            };
            await persistResult(store, runId, opts.fixture, r);
            return r;
        }
        const replaySession = loadSession(replayJsonl);
        const diff = diffStreams(original.events, replaySession.events);
        const result = {
            runId,
            fixtureId,
            usecase,
            verdict: verdictFromDiff(diff),
            diff,
            originalTurns: original.turns,
            replayTurns,
            durationMs: Date.now() - start,
        };
        await persistResult(store, runId, opts.fixture, result);
        return result;
    }
    finally {
        await safeRm(sandbox);
    }
};
const persistResult = async (store, runId, source, r) => {
    await store.append(runId, {
        tier: "trajectory",
        usecase: r.usecase === "unclassified" ? "unclassified" : r.usecase,
        payload: {
            kind: "trajectory",
            source,
            sessionId: r.fixtureId,
            confidence: 1,
            turns: r.originalTurns,
            ...(r.diff !== undefined
                ? { replay: { matched: r.diff.matched, divergedEvents: r.diff.divergedEvents } }
                : {}),
        },
    });
    const counts = {
        pass: r.verdict === "pass" ? 1 : 0,
        partial: r.verdict === "partial" ? 1 : 0,
        fail: r.verdict === "fail" ? 1 : 0,
        error: r.verdict === "error" ? 1 : 0,
        skipped: r.verdict === "skipped" ? 1 : 0,
    };
    await store.finish({
        runId,
        tier: "trajectory",
        argv: process.argv.slice(2),
        counts,
        durationMs: r.durationMs,
    });
};
