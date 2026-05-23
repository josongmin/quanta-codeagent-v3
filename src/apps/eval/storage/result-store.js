import { errMessage } from "@/shared";
/**
 * JSONL append-only store for `EvalRecord`. One file per run id keeps tier
 * runs isolated and trivially diff-able. Reads scan a directory and stream
 * lines back — the dataset is never expected to exceed a few hundred MB so
 * naïve readFile is fine; switch to `Bun.file().stream()` if that changes.
 *
 * The store is intentionally I/O only — schema validation lives in
 * `schema.ts`, aggregation in `report/`. Keep this file dependency-light.
 *
 * Write atomicity contract (Phase B hardening):
 *   - One run-id ⇒ ONE file. Concurrent `append()` calls to the SAME runId
 *     are serialised through a per-runId promise queue so `appendFileSync`
 *     calls cannot interleave at line boundaries. Compare-tier (`runCompare`)
 *     fires N adapters in parallel against one runId — without serialisation
 *     two simultaneous `append`s can corrupt the JSONL.
 *   - Different runIds write to different files and are NOT cross-serialised.
 *
 * Read validation contract:
 *   - Unknown `payload.kind` ⇒ DROPPED + warn log (never silently yielded).
 *   - Schema version mismatch ⇒ DROPPED + warn log (no silent migration).
 *   - Malformed JSON / missing required envelope ⇒ DROPPED + warn log.
 * Each drop reason is observable so an operator can see why a run looks empty.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hrtime } from "node:process";
import { logger } from "@/shared";
import { isKnownPayloadKind, SCHEMA_VERSION } from "./schema";
/** Default runs dir (overridable via constructor for tests). */
export const DEFAULT_RUNS_DIR = "evals/runs";
/** Default randomness: 4 cryptographically-random bytes (8 hex chars) plus
 *  the nanosecond fragment of `hrtime`. Two `makeRunId` calls within the same
 *  millisecond have negligible collision probability — important because
 *  `appendFileSync` to the same path APPENDS, silently merging unrelated runs. */
const defaultRand = () => {
    const hex = randomBytes(4).toString("hex");
    const ns = hrtime.bigint() % 0xffffn;
    return `${hex}${ns.toString(16).padStart(4, "0")}`;
};
/** Generate a sortable, human-readable run id: `YYYYMMDD-HHMMSS-<tier>-<rand>`. */
export const makeRunId = (tier, now = () => Date.now(), rand = defaultRand) => {
    const d = new Date(now());
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    return `${stamp}-${tier}-${rand()}`;
};
export class ResultStore {
    dir;
    now;
    /** Per-runId write tail. `append`/`finish` enqueue onto the runId's tail so
     *  concurrent callers serialise within one file. Different runIds have
     *  independent tails (no cross-contention). */
    writeTails = new Map();
    constructor(opts = {}) {
        this.dir = opts.dir ?? DEFAULT_RUNS_DIR;
        this.now = opts.now ?? (() => Date.now());
        mkdirSync(this.dir, { recursive: true });
    }
    /** Enqueue an `appendFileSync` call onto the runId's serialisation tail.
     *  Returns the awaited promise so callers can `await store.append(...)`
     *  when they need strict ordering. */
    enqueue(runId, write) {
        const prev = this.writeTails.get(runId) ?? Promise.resolve();
        const next = prev.then(write).catch((e) => {
            logger.warn("eval.store: append failed", {
                runId,
                error: errMessage(e),
            });
        });
        this.writeTails.set(runId, next);
        return next;
    }
    /** Append one record to its run file. The envelope is stamped here so
     *  callers only fill in tier-specific fields (`tier`, `usecase`, `payload`).
     *  Returns a promise for callers that need ordering; sync callers may ignore
     *  it (the tail is recorded internally either way). */
    append(runId, rec) {
        const full = {
            ts: this.now(),
            schema: SCHEMA_VERSION,
            runId,
            ...rec,
        };
        const line = `${JSON.stringify(full)}\n`;
        const path = this.fileFor(runId);
        return this.enqueue(runId, () => appendFileSync(path, line));
    }
    /** Write the run summary as the LAST line. Idempotent at the API level
     *  (callers should call once). Serialises behind any pending `append`s. */
    finish(rec) {
        const full = {
            ts: this.now(),
            schema: SCHEMA_VERSION,
            ...rec,
        };
        const line = `${JSON.stringify({ ...full, kind: "run_summary" })}\n`;
        const path = this.fileFor(rec.runId);
        return this.enqueue(rec.runId, () => appendFileSync(path, line));
    }
    /** Read every record across every run. Drops lines that fail validation
     *  with a warn log so an operator can see WHY a run looks empty. */
    *readAll() {
        if (!existsSync(this.dir))
            return;
        const files = readdirSync(this.dir)
            .filter((f) => f.endsWith(".jsonl"))
            .sort();
        for (const f of files) {
            yield* this.readOne(f);
        }
    }
    *readOne(file) {
        const path = join(this.dir, file);
        let text;
        try {
            text = readFileSync(path, "utf8");
        }
        catch (e) {
            logger.warn("eval.store: read failed", {
                file,
                error: errMessage(e),
            });
            return;
        }
        let schemaMismatchSeen = false;
        for (const line of text.split("\n")) {
            if (line === "")
                continue;
            let obj;
            try {
                obj = JSON.parse(line);
            }
            catch (e) {
                logger.warn("eval.store: skip malformed line", {
                    file,
                    linePreview: line.slice(0, 120),
                    error: errMessage(e),
                });
                continue;
            }
            if (obj.schema !== SCHEMA_VERSION) {
                if (!schemaMismatchSeen) {
                    schemaMismatchSeen = true;
                    logger.warn("eval.store: skipping records with mismatched schema", {
                        file,
                        sawSchema: obj.schema,
                        wantSchema: SCHEMA_VERSION,
                    });
                }
                continue;
            }
            if (obj.kind === "run_summary")
                continue;
            if (typeof obj.tier !== "string" || typeof obj.usecase !== "string") {
                logger.warn("eval.store: skip line missing envelope fields", { file });
                continue;
            }
            if (typeof obj.payload !== "object" || obj.payload === null) {
                logger.warn("eval.store: skip line with missing/non-object payload", { file });
                continue;
            }
            const payloadKind = obj.payload.kind;
            if (typeof payloadKind !== "string" || !isKnownPayloadKind(payloadKind)) {
                logger.warn("eval.store: skip line with unknown payload kind", {
                    file,
                    kind: payloadKind,
                });
                continue;
            }
            yield obj;
        }
    }
    /** Absolute path of the file for a given run id (callers may inspect). */
    fileFor(runId) {
        return join(this.dir, `${runId}.jsonl`);
    }
    /** Test/finalise helper: await all in-flight writes across every runId.
     *  Cleanly closing a run that did `append()` without `await` requires this
     *  so the file is on disk before the next reader runs. */
    async drain() {
        const tails = [...this.writeTails.values()];
        await Promise.all(tails);
    }
}
