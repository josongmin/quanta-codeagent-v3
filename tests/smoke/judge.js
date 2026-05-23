const JUDGE_SYSTEM = "You are a strict evaluator. Given a RUBRIC and an agent's RESPONSE, decide " +
    "how well the response satisfies the rubric. Reply with ONLY a JSON object: " +
    '{"score": <number between 0 and 1>, "rationale": "<one sentence>"}. ' +
    "score 1 = fully satisfies, 0 = does not satisfy.";
const buildJudgeInput = (rubric, text) => ({
    messages: [
        {
            role: "user",
            content: [
                { type: "text", text: `RUBRIC:\n${rubric}\n\nRESPONSE:\n${text}\n\nReturn the JSON now.` },
            ],
        },
    ],
    system: JUDGE_SYSTEM,
    tools: [],
});
/** Extract + parse the first `{...}` JSON object from a model reply. Returns a
 *  fail-closed `{score:0}` when nothing parses. */
export const parseJudgeReply = (raw) => {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
        return { score: 0, rationale: `unparseable judge reply: ${raw.slice(0, 120)}` };
    }
    try {
        const obj = JSON.parse(raw.slice(start, end + 1));
        const score = typeof obj.score === "number" && Number.isFinite(obj.score) ? obj.score : 0;
        const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
        return { score: Math.max(0, Math.min(1, score)), rationale };
    }
    catch {
        return { score: 0, rationale: `invalid judge JSON: ${raw.slice(0, 120)}` };
    }
};
/** Live judge call. Accepts an optional {@link AbortSignal} so the runner's
 *  wallSeconds budget can actually cut a wedged provider — pre-fix, a stalled
 *  judge stream would hang `applyJudge` forever and the budget check was DEAD
 *  CODE (it sits AFTER applyJudge in the runner). When the signal aborts mid-
 *  stream the partial reply is parsed (fail-closed → score 0) instead of
 *  silently hanging. */
export const runJudge = async (args) => {
    let raw = "";
    try {
        for await (const ev of args.llm.stream(buildJudgeInput(args.judge.rubric, args.text))) {
            if (args.signal?.aborted)
                break;
            if (ev.type === "text_delta")
                raw += ev.delta;
        }
    }
    catch (e) {
        return {
            score: 0,
            rationale: `judge stream failed: ${e.message ?? String(e)}`,
        };
    }
    return parseJudgeReply(raw);
};
