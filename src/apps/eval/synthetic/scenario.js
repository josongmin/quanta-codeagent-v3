/**
 * Synthetic scenario schema. One JSON file per scenario, grouped under
 * `scenarios/<usecase-id>/<scenario-id>.json`.
 *
 * Keep the schema additive — older scenarios must remain runnable when a new
 * optional field is added. Breaking changes require a schema bump consumed by
 * `loadScenario`.
 *
 * Why JSON not YAML: no parser dep, hand-editable, diffs cleanly. The cost is
 * verbosity; pay it.
 */
import { readFileSync } from "node:fs";
export const SCENARIO_SCHEMA_VERSION = 1;
/** Tolerant loader: validates required fields, fills defaults, throws on shape error. */
export const parseScenario = (raw) => {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("scenario must be an object");
    }
    const r = raw;
    const schema = r["schema"];
    if (schema !== SCENARIO_SCHEMA_VERSION) {
        throw new Error(`scenario schema mismatch: got ${String(schema)}, want ${SCENARIO_SCHEMA_VERSION}`);
    }
    const id = r["id"];
    const usecase = r["usecase"];
    const title = r["title"];
    const prompt = r["prompt"];
    const rubric = r["rubric"];
    if (typeof id !== "string" ||
        typeof usecase !== "string" ||
        typeof title !== "string" ||
        typeof prompt !== "string" ||
        !Array.isArray(rubric) ||
        rubric.length === 0) {
        throw new Error("scenario missing required fields: id, usecase, title, prompt, rubric[]");
    }
    // Validate optional `forbidden`/`maxTurns` strictly: a silently-dropped
    // non-string in `forbidden` would defeat the safety net (e.g. model emits
    // `[{pattern:"rm -rf"}]` → empty list → unguarded). `maxTurns` is the
    // loop ceiling, so a NaN/negative/zero value would either crash runAgent or
    // produce a zero-turn run scored as fail.
    const forbiddenRaw = r["forbidden"];
    let forbidden;
    if (forbiddenRaw !== undefined) {
        if (!Array.isArray(forbiddenRaw)) {
            throw new Error("scenario.forbidden must be a string array when present");
        }
        for (const x of forbiddenRaw) {
            if (typeof x !== "string") {
                throw new Error(`scenario.forbidden contains non-string entry: ${JSON.stringify(x)}`);
            }
        }
        forbidden = forbiddenRaw;
    }
    const maxTurnsRaw = r["maxTurns"];
    let maxTurns;
    if (maxTurnsRaw !== undefined) {
        if (typeof maxTurnsRaw !== "number" || !Number.isInteger(maxTurnsRaw) || maxTurnsRaw < 1) {
            throw new Error(`scenario.maxTurns must be a positive integer (got ${String(maxTurnsRaw)})`);
        }
        maxTurns = maxTurnsRaw;
    }
    const out = {
        schema: SCENARIO_SCHEMA_VERSION,
        id,
        usecase,
        title,
        prompt,
        rubric: rubric.map(parseRubric),
        ...(Array.isArray(r["files"]) ? { files: r["files"].map(parseFile) } : {}),
        ...(typeof r["setupCmd"] === "string" ? { setupCmd: r["setupCmd"] } : {}),
        ...(forbidden !== undefined ? { forbidden } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
    return out;
};
const parseRubric = (raw) => {
    if (typeof raw !== "object" || raw === null)
        throw new Error("rubric item must be object");
    const r = raw;
    const id = r["id"];
    const description = r["description"];
    if (typeof id !== "string" || typeof description !== "string") {
        throw new Error("rubric item requires id, description");
    }
    return {
        id,
        description,
        ...(typeof r["weight"] === "number" && r["weight"] > 0 && r["weight"] <= 1
            ? { weight: r["weight"] }
            : {}),
    };
};
const parseFile = (raw) => {
    if (typeof raw !== "object" || raw === null)
        throw new Error("file entry must be object");
    const r = raw;
    const path = r["path"];
    const content = r["content"];
    if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("file entry requires path, content");
    }
    return { path, content };
};
export const loadScenarioFile = (path) => {
    const text = readFileSync(path, "utf8");
    return parseScenario(JSON.parse(text));
};
