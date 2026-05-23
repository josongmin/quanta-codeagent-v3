import { assembleFromEvents } from "@/llm";
import { errMessage, logger } from "@/shared";
const SYSTEM = [
    "You are a code-quality judge. Two coding agents (A and B) attempted the SAME task.",
    "Pick the one that better satisfies the rubric. Reply with ONE JSON object only.",
    'Shape: { "winner": "A" | "B" | "tie", "why": "<≤140 chars>" }',
    "Score on rubric satisfaction, NOT verbosity. Ties are allowed but should be rare.",
].join("\n");
const buildUser = (scenario, a, b) => {
    const rubric = scenario.rubric.map((r, i) => `${i + 1}. ${r.description}`).join("\n");
    return [
        `Task: ${scenario.title}`,
        "",
        "Prompt given to both agents:",
        "---",
        scenario.prompt,
        "---",
        "",
        "Rubric:",
        rubric,
        "",
        `Agent A (${a.agent}, ${a.durationMs}ms, exitOk=${a.exitOk}):`,
        "---",
        a.transcript.length > 0 ? a.transcript : "(no output)",
        "---",
        "",
        `Agent B (${b.agent}, ${b.durationMs}ms, exitOk=${b.exitOk}):`,
        "---",
        b.transcript.length > 0 ? b.transcript : "(no output)",
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
const parsePairwise = (raw) => {
    const block = extractJson(raw);
    if (block === null) {
        return { raw: { kind: "parse_failed", reason: "no JSON object" }, note: "" };
    }
    let obj;
    try {
        obj = JSON.parse(block);
    }
    catch (e) {
        return {
            raw: {
                kind: "parse_failed",
                reason: `JSON parse: ${errMessage(e)}`,
            },
            note: "",
        };
    }
    const w = obj.winner;
    const note = typeof obj.why === "string" ? obj.why : "";
    if (w === "A" || w === "B" || w === "tie") {
        return { raw: { kind: "winner", winner: w }, note };
    }
    return {
        raw: { kind: "parse_failed", reason: `unexpected winner value: ${String(w)}` },
        note,
    };
};
const ask = async (llm, system, user) => {
    const events = [];
    try {
        for await (const ev of llm.stream({
            system: [{ type: "text", text: system }],
            messages: [{ role: "user", content: [{ type: "text", text: user }] }],
            tools: [],
        })) {
            events.push(ev);
        }
    }
    catch (e) {
        return {
            raw: {
                kind: "parse_failed",
                reason: `llm stream: ${errMessage(e)}`,
            },
            note: "",
        };
    }
    const { message } = assembleFromEvents(events);
    const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    return parsePairwise(text);
};
/** Resolve forward + swapped verdicts into a single winner index. Two
 *  verdicts agree IFF forward picks the same participant as swapped (after
 *  swapping back: forward=A AND swapped=B both point to participant 0). */
const resolveWinner = (forward, swapped) => {
    if (forward === "tie" || swapped === "tie")
        return -1;
    // forward says A is better → original index 0
    // swapped says A is better (was: original B) → original index 1
    const forwardIdx = forward === "A" ? 0 : 1;
    const swappedIdx = swapped === "A" ? 1 : 0;
    if (forwardIdx !== swappedIdx)
        return -1;
    return forwardIdx;
};
const winnerOrTie = (raw) => raw.kind === "winner" ? raw.winner : "tie";
export const pairwiseJudge = async (scenario, a, b, opts) => {
    const system = opts.judgePrompt ?? SYSTEM;
    const forward = await ask(opts.llm, system, buildUser(scenario, a, b));
    const swapped = await ask(opts.llm, system, buildUser(scenario, b, a));
    const parseFailed = forward.raw.kind === "parse_failed" || swapped.raw.kind === "parse_failed";
    if (parseFailed) {
        logger.warn("compare.judge: parse failed on at least one pass — recording as inconclusive", {
            forwardKind: forward.raw.kind,
            swappedKind: swapped.raw.kind,
            forwardReason: forward.raw.kind === "parse_failed" ? forward.raw.reason : undefined,
            swappedReason: swapped.raw.kind === "parse_failed" ? swapped.raw.reason : undefined,
        });
    }
    const forwardW = winnerOrTie(forward.raw);
    const swappedW = winnerOrTie(swapped.raw);
    return {
        forward: forwardW,
        swapped: swappedW,
        winnerIndex: parseFailed ? -1 : resolveWinner(forwardW, swappedW),
        parseFailed,
        note: forward.note,
    };
};
export { resolveWinner };
