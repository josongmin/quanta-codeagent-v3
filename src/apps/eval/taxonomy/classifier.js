import { assembleFromEvents } from "@/llm";
import { errMessage } from "@/shared";
import { allLeaves, formatLeafLine, leafById } from "./index";
const SYSTEM_PROMPT = [
    "You classify a developer's question or instruction to a coding agent.",
    "Reply with a SINGLE JSON object only — no prose, no markdown fences.",
    'Shape: { "id": "<leaf-id>", "confidence": 0.0-1.0, "alt": ["<leaf-id>", ...] }',
    "Use the EXACT leaf id from the list. If none fit, set id to null.",
].join("\n");
const buildUserPrompt = (query) => {
    const lines = allLeaves().map(formatLeafLine);
    return [
        "Leaf catalog (id: label — example):",
        lines.join("\n"),
        "",
        "Query to classify:",
        query.trim(),
    ].join("\n");
};
/** Pull the first balanced `{...}` block from arbitrary text. */
const extractJsonObject = (s) => {
    const start = s.indexOf("{");
    if (start < 0)
        return null;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (ch === "{")
            depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0)
                return s.slice(start, i + 1);
        }
    }
    return null;
};
const errResult = (raw, error) => ({
    id: null,
    confidence: 0,
    alt: [],
    raw,
    error,
});
const parse = (raw, maxAlt) => {
    const block = extractJsonObject(raw);
    if (block === null)
        return errResult(raw, "no JSON object in response");
    let obj;
    try {
        obj = JSON.parse(block);
    }
    catch (e) {
        return errResult(raw, `JSON parse: ${errMessage(e)}`);
    }
    // Model may legitimately reply `{"id": null}` — that's the "none of the
    // above" path and is NOT an error.
    const idRaw = typeof obj.id === "string" ? obj.id : null;
    const id = idRaw !== null && leafById(idRaw) !== undefined ? idRaw : null;
    const conf = typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : 0;
    const altIn = Array.isArray(obj.alt) ? obj.alt : [];
    const alt = [];
    for (const a of altIn) {
        if (typeof a !== "string")
            continue;
        if (a === id)
            continue;
        if (leafById(a) === undefined)
            continue;
        alt.push(a);
        if (alt.length >= maxAlt)
            break;
    }
    return { id, confidence: conf, alt, raw };
};
export const classifyQuery = async (query, opts) => {
    const messages = [
        { role: "user", content: [{ type: "text", text: buildUserPrompt(query) }] },
    ];
    const events = [];
    try {
        for await (const e of opts.llm.stream({
            system: [{ type: "text", text: SYSTEM_PROMPT }],
            messages,
            tools: [],
        })) {
            events.push(e);
        }
    }
    catch (e) {
        return errResult("", `llm stream: ${errMessage(e)}`);
    }
    const { message } = assembleFromEvents(events);
    const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    return parse(text, opts.maxAlt ?? 2);
};
