/**
 * Per-attempt observation wiring + bench-event emission helpers.
 *
 * RFC-0002 §8 observability seam. `buildWiring(observe)` returns either a bare
 * `NullStream` (default-OFF, byte-identical to pre-W-D behavior) or a strict
 * `TeeStream([NullStream, JsonlRecorder, UsageTap])`. The per-event helpers
 * (`emitSandbox`/`emitPatch`/`emitVerify`) wrap append calls in
 * `ObservationError` so the driver can map a strict-recorder failure to
 * `verdict:"degraded"`.
 *
 * `BenchObserver`/`UsageTap`/`countDiff`/`verifyLogTail` live in `../observe`
 * and are re-exported by `./index` for the public barrel; this file uses them
 * but does not own them.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { errMessage, redactValue } from "@/shared";
import { TeeStream } from "@/stream";
import { BenchObserver, countDiff, UsageTap, verifyLogTail, } from "../observe";
import { gatherSandbox } from "./snapshot";
/** StreamPort that swallows every event — silent benchmark runs. */
export class NullStream {
    emit(_event) {
        // intentionally empty
    }
}
/** Marker thrown when a strict (eval) recorder/observer write fails so the
 *  outer catch can map it to `verdict:"degraded"` (RFC §3/§8/§12). */
export class ObservationError extends Error {
    constructor(cause) {
        super(errMessage(cause));
        this.name = "ObservationError";
    }
}
/** Build the agent stream. Default-off ⇒ a bare `NullStream`. Observing ⇒
 *  `TeeStream([NullStream, JsonlRecorder, UsageTap], {strict:true})` so a
 *  recorder failure rethrows for `verdict:"degraded"` handling (RFC §8). */
export const buildWiring = (instance, observe) => {
    if (observe === undefined)
        return { stream: new NullStream() };
    let observer;
    try {
        observer = new BenchObserver(observe, instance.id);
    }
    catch (e) {
        // Strict (eval): an unwritable observe dir is an observation failure, not
        // a silent fallback — surface it so the instance is marked degraded.
        throw new ObservationError(e);
    }
    const usage = new UsageTap();
    const stream = new TeeStream([new NullStream(), observer.recorder, usage], { strict: true });
    return { stream, observer, usage };
};
/** Emit the one-shot `sandbox` snapshot before the agent runs. Strict: a
 *  recorder failure becomes an {@link ObservationError}. */
export const emitSandbox = async (observer, sandbox, baseCommit, timeoutMs) => {
    if (observer === undefined)
        return;
    const data = await gatherSandbox(sandbox, baseCommit, timeoutMs);
    try {
        observer.sandbox(data);
    }
    catch (e) {
        throw new ObservationError(e);
    }
};
/** Persist the unified diff to `<run>/<id>.<attempt>.patch` and emit
 *  `patch_generated` (filesChanged:0 for an empty patch). Returns the patch
 *  file path so it lands in the summary. */
export const emitPatch = (observe, instance, observer, patch) => {
    const attempt = observe.attempt ?? 0;
    const diffPath = join(observe.dir, observe.runId, `${instance.id}.${attempt}.patch`);
    // S2: a committed `.env`/fixture token captured in the diff must NOT land
    // raw on disk. Scrub via the single-source @/shared redactor; countDiff runs
    // on the scrubbed text so filesChanged/hunks still reflect what we wrote.
    const safePatch = redactValue(patch);
    const { filesChanged, hunks } = countDiff(safePatch);
    try {
        writeFileSync(diffPath, safePatch);
        observer.patchGenerated({ diffPath, filesChanged, hunks, applyStatus: "generated" });
    }
    catch (e) {
        throw new ObservationError(e);
    }
    return diffPath;
};
export const emitVerify = (observer, v) => {
    if (observer === undefined)
        return;
    try {
        observer.verify({
            command: v.command,
            exitCode: v.exitCode,
            passed: v.passed,
            failedTests: v.failedTests,
            logTail: verifyLogTail(v.logTail),
            reportPath: v.reportPath,
        });
    }
    catch (e) {
        throw new ObservationError(e);
    }
};
