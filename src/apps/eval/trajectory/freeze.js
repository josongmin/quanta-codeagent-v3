/**
 * Promote a real JSONL session into a regression fixture under
 * `src/apps/eval/trajectory/fixtures/<usecase>/<id>.jsonl`. The original meta
 * sidecar (if present) is copied; if absent the caller MUST supply
 * `userPrompt` so the frozen fixture is replayable (no heuristic
 * reconstruction).
 *
 * Strict refusal posture: if neither the meta sidecar nor an inline prompt is
 * provided, `freezeFixture` returns `null` and writes nothing. Replay would
 * later refuse the fixture anyway, so failing at freeze time keeps the
 * fixtures dir honest.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { readMeta, writeMeta } from "./meta";
const DEFAULT_ROOT = "src/apps/eval/trajectory/fixtures";
export const freezeFixture = (opts) => {
    const sourceMeta = readMeta(opts.source);
    if (sourceMeta === null && opts.prompt === undefined)
        return null;
    const root = opts.fixturesRoot ?? DEFAULT_ROOT;
    const targetDir = join(root, opts.usecase);
    mkdirSync(targetDir, { recursive: true });
    const fixturePath = join(targetDir, basename(opts.source));
    copyFileSync(opts.source, fixturePath);
    const meta = sourceMeta !== null
        ? { ...sourceMeta, usecase: opts.usecase }
        : {
            schema: 1,
            userPrompt: opts.prompt ?? "",
            cwd: opts.cwd ?? "unknown",
            usecase: opts.usecase,
            producer: { name: "eval.freeze", version: "1" },
            recordedAt: new Date().toISOString(),
        };
    writeMeta(fixturePath, meta);
    return { fixturePath, metaPath: `${fixturePath}.meta.json` };
};
