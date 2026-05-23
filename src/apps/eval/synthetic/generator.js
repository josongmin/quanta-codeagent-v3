/**
 * LLM-driven synthetic scenario generator. Given a `UseCaseId`, produces N
 * fully-formed `Scenario` JSON files under `scenarios/<usecase-id>/`.
 *
 * Hard constraints on the model output:
 *   - Schema must match `Scenario` exactly (validated by `parseScenario`).
 *   - The generated `usecase` field MUST equal the requested id (we overwrite
 *     it after parse — model picks the wrong id ⇒ correct it).
 *   - At least 3 rubric items per scenario.
 *   - At most 4 setup files; each ≤ 4KB to keep fixtures git-friendly.
 *
 * A model that produces invalid JSON or violates the constraints is REJECTED
 * — we never write a half-broken scenario file. Caller sees `accepted` vs
 * `rejected` counts and a short reason per rejection.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleFromEvents } from "@/llm";
import { errMessage, logger } from "@/shared";
import { allLeaves, leafById } from "../taxonomy";
import { parseScenario, SCENARIO_SCHEMA_VERSION } from "./scenario";
const DEFAULT_ROOT = "src/apps/eval/synthetic/scenarios";
const DEFAULT_MAX_FILE = 4096;
const SYSTEM = [
    "You generate test scenarios for a coding-agent evaluation harness.",
    "Each scenario tests ONE use case: an agent reads the prompt, optionally edits files in a sandbox, and a judge scores the result against the rubric.",
    "Reply with a SINGLE JSON array — no prose, no markdown fences.",
    "Each element MUST conform to this exact shape:",
    "{",
    '  "schema": 1,',
    '  "id": "<short-kebab-case-id, unique within the array>",',
    '  "usecase": "<exact leaf id provided by the user>",',
    '  "title": "<≤80 chars>",',
    '  "prompt": "<the user message handed to the agent verbatim>",',
    '  "files": [{ "path": "<rel-path>", "content": "<≤4KB>" }],',
    '  "rubric": [{ "id": "<rubric-id>", "description": "<criterion the judge scores>", "weight": 0.1-1.0 }],',
    '  "forbidden": ["<substring that must not appear in any tool input>"],',
    '  "maxTurns": 6',
    "}",
    "Rubric MUST have ≥3 items; the LAST item should typically verify the agent EXECUTED a check (test, type-check, run).",
    "Generate diverse, realistic scenarios — vary file shapes, bug types, prompt styles.",
].join("\n");
const buildUser = (count, usecaseId) => {
    const leaf = leafById(usecaseId);
    const leafLabel = leaf?.label ?? usecaseId;
    const examples = leaf?.examples.map((e) => `"${e}"`).join(", ") ?? "(none)";
    // Reference 3 sibling leaves (same major) so the model picks distinguishing tasks.
    const siblings = allLeaves()
        .filter((l) => l.id !== usecaseId && l.id.split(".")[0] === usecaseId.split(".")[0])
        .slice(0, 3)
        .map((l) => `  - ${l.id}: ${l.label}`)
        .join("\n");
    return [
        `Generate exactly ${count} scenario(s) for use case: ${usecaseId}`,
        `Label: ${leafLabel}`,
        `Real-world trigger examples: ${examples}`,
        "",
        "Sibling use cases (do NOT overlap with these):",
        siblings,
        "",
        `Set every scenario's "usecase" field to: ${usecaseId}`,
    ].join("\n");
};
/** Extract the first top-level JSON array from arbitrary text. */
const extractJsonArray = (s) => {
    const start = s.indexOf("[");
    if (start < 0)
        return null;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (ch === "[")
            depth++;
        else if (ch === "]") {
            depth--;
            if (depth === 0)
                return s.slice(start, i + 1);
        }
    }
    return null;
};
const validateExtra = (scenario, maxFileBytes) => {
    if (scenario.rubric.length < 3)
        return { ok: false, reason: "rubric < 3 items" };
    if (scenario.files !== undefined) {
        if (scenario.files.length > 4)
            return { ok: false, reason: "files > 4" };
        for (const f of scenario.files) {
            if (Buffer.byteLength(f.content, "utf8") > maxFileBytes) {
                return { ok: false, reason: `file ${f.path} > ${maxFileBytes}B` };
            }
        }
    }
    return { ok: true };
};
const safeParseOne = (raw, requestedUsecase, maxFileBytes) => {
    if (typeof raw !== "object" || raw === null) {
        return { ok: false, reason: "scenario is not an object" };
    }
    const r = raw;
    // REFUSE wrong usecase / wrong schema rather than silently coercing — the
    // model picking the wrong leaf is a real signal that the prompt or the
    // taxonomy needs work; masking it strands future drift.
    const declaredUsecase = r["usecase"];
    if (declaredUsecase !== requestedUsecase) {
        return {
            ok: false,
            reason: `usecase mismatch: model produced "${String(declaredUsecase)}" but request was "${requestedUsecase}"`,
        };
    }
    const declaredSchema = r["schema"];
    if (declaredSchema !== SCENARIO_SCHEMA_VERSION) {
        return {
            ok: false,
            reason: `schema mismatch: model produced ${String(declaredSchema)}, want ${SCENARIO_SCHEMA_VERSION}`,
        };
    }
    let scenario;
    try {
        scenario = parseScenario(raw);
    }
    catch (e) {
        return { ok: false, reason: errMessage(e) };
    }
    const extra = validateExtra(scenario, maxFileBytes);
    if (!extra.ok)
        return { ok: false, reason: extra.reason };
    return { ok: true, scenario };
};
export const generateScenarios = async (opts) => {
    if (leafById(opts.usecase) === undefined) {
        throw new Error(`unknown usecase: ${opts.usecase}`);
    }
    const messages = [
        { role: "user", content: [{ type: "text", text: buildUser(opts.count, opts.usecase) }] },
    ];
    const events = [];
    for await (const ev of opts.llm.stream({
        system: [{ type: "text", text: SYSTEM }],
        messages,
        tools: [],
    })) {
        events.push(ev);
    }
    const { message } = assembleFromEvents(events);
    const raw = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    const block = extractJsonArray(raw);
    if (block === null) {
        return { accepted: [], rejected: [{ reason: "no JSON array in response", raw }] };
    }
    let arr;
    try {
        arr = JSON.parse(block);
    }
    catch (e) {
        return {
            accepted: [],
            rejected: [{ reason: `JSON parse: ${errMessage(e)}`, raw }],
        };
    }
    if (!Array.isArray(arr)) {
        return { accepted: [], rejected: [{ reason: "top-level is not an array", raw }] };
    }
    const outDir = opts.outRoot ?? join(DEFAULT_ROOT, opts.usecase);
    mkdirSync(outDir, { recursive: true });
    const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
    const accepted = [];
    const rejected = [];
    const seenIds = new Set();
    for (const item of arr) {
        const r = safeParseOne(item, opts.usecase, maxFileBytes);
        if (!r.ok) {
            rejected.push({ reason: r.reason, raw: JSON.stringify(item).slice(0, 400) });
            continue;
        }
        if (seenIds.has(r.scenario.id)) {
            rejected.push({ reason: `duplicate id ${r.scenario.id}`, raw: "" });
            continue;
        }
        seenIds.add(r.scenario.id);
        const filePath = join(outDir, `${r.scenario.id}.json`);
        writeFileSync(filePath, `${JSON.stringify(r.scenario, null, 2)}\n`);
        accepted.push({ path: filePath, scenario: r.scenario });
    }
    logger.info("eval.generator: done", {
        usecase: opts.usecase,
        accepted: accepted.length,
        rejected: rejected.length,
    });
    return { accepted, rejected };
};
