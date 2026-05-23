import { assembleFromEvents } from "@/llm";
import { errMessage } from "@/shared";
const DEFAULT_SYSTEM = [
    "You are a strict but fair code-review judge.",
    "Score each rubric item PASS or FAIL based ONLY on the agent transcript and tool usage shown.",
    "Reply with a SINGLE JSON object only — no prose, no markdown fences.",
    'Shape: { "rubric": [ { "id": "<rubric-id>", "pass": true|false, "why": "<≤120 chars>" } ] }',
    "Order MUST match the input rubric. Include every item.",
].join("\n");
const buildUser = (i) => {
    const rubricLines = i.scenario.rubric
        .map((r, idx) => `${idx + 1}. id=${r.id} — ${r.description}`)
        .join("\n");
    return [
        `Use case: ${i.scenario.usecase}`,
        `Scenario: ${i.scenario.title}`,
        "",
        "User prompt to the agent:",
        "---",
        i.scenario.prompt,
        "---",
        "",
        "Rubric:",
        rubricLines,
        "",
        `Agent finished in ${i.turns} turn(s), stop=${i.stopReason}.`,
        `Tools used (in order): ${i.toolsUsed.length === 0 ? "(none)" : i.toolsUsed.join(", ")}`,
        "",
        "Agent assistant text (full):",
        "---",
        i.assistantText.length > 0 ? i.assistantText : "(no assistant text)",
        "---",
    ].join("\n");
};
const extractJson = (s) => {
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
const weightedScore = (rubric, verdicts) => {
    let acc = 0;
    let total = 0;
    const verdictById = new Map(verdicts.map((v) => [v.id, v.pass]));
    for (const item of rubric) {
        const w = item.weight ?? 1;
        total += w;
        if (verdictById.get(item.id) === true)
            acc += w;
    }
    return total === 0 ? 0 : acc / total;
};
const errVerdict = (rubric, raw, error) => ({
    rubric: rubric.map((r) => ({ name: r.id, pass: false })),
    score: 0,
    raw,
    error,
});
export const judge = async (input, opts) => {
    const messages = [
        { role: "user", content: [{ type: "text", text: buildUser(input) }] },
    ];
    const events = [];
    try {
        for await (const e of opts.llm.stream({
            system: [{ type: "text", text: opts.judgePrompt ?? DEFAULT_SYSTEM }],
            messages,
            tools: [],
        })) {
            events.push(e);
        }
    }
    catch (e) {
        return errVerdict(input.scenario.rubric, "", `llm stream: ${errMessage(e)}`);
    }
    const { message } = assembleFromEvents(events);
    const raw = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    return parseVerdict(raw, input.scenario.rubric);
};
const parseVerdict = (raw, rubric) => {
    const block = extractJson(raw);
    if (block === null)
        return errVerdict(rubric, raw, "no JSON object in response");
    let obj;
    try {
        obj = JSON.parse(block);
    }
    catch (e) {
        return errVerdict(rubric, raw, `JSON parse: ${errMessage(e)}`);
    }
    if (typeof obj !== "object" || obj === null) {
        return errVerdict(rubric, raw, "response is not an object");
    }
    const items = obj.rubric;
    if (!Array.isArray(items))
        return errVerdict(rubric, raw, "response.rubric is not an array");
    const parsed = [];
    for (const it of items) {
        if (typeof it !== "object" || it === null)
            continue;
        const id = it.id;
        const pass = it.pass;
        if (typeof id === "string" && typeof pass === "boolean")
            parsed.push({ id, pass });
    }
    // Every rubric item MUST have a verdict in the response. A model that
    // returned a partial set is malformed — surface that as an error rather
    // than letting unscored items default-fail and tank the score.
    if (parsed.length < rubric.length) {
        return errVerdict(rubric, raw, `partial verdict: ${parsed.length}/${rubric.length} rubric items scored`);
    }
    const verdictById = new Map(parsed.map((p) => [p.id, p.pass]));
    return {
        rubric: rubric.map((r) => ({ name: r.id, pass: verdictById.get(r.id) ?? false })),
        score: weightedScore(rubric, parsed),
        raw,
    };
};
