const DEFAULT_MAX = 12000;
const HEADER_PROBLEM = "Original problem (verbatim):";
const HEADER_DIFF = "Your patch so far (cumulative):";
const HEADER_FAIL = "Validation failed. Tail of failing output:";
const NEXT_STEPS = [
    "Next steps (MANDATORY):",
    "- Do NOT revert your patch. NEVER run `git checkout`, `git reset`, `git clean`, or `git stash`.",
    "- Analyze the failing output above and fix the SOURCE code (not test files).",
    "- After your edit, rerun the SAME verification command before you stop.",
    "- An unverified edit is not done — iterate until the command passes.",
].join("\n");
const MARKER_OVERHEAD = 40; // worst-case bytes added by a "… <N bytes truncated>" line
const trimTail = (s, target) => {
    if (s.length <= target)
        return s;
    const room = Math.max(0, target - MARKER_OVERHEAD);
    const dropped = s.length - room;
    return `… <${dropped} bytes truncated>\n${s.slice(-room)}`;
};
const trimHead = (s, target) => {
    if (s.length <= target)
        return s;
    const room = Math.max(0, target - MARKER_OVERHEAD);
    const dropped = s.length - room;
    return `${s.slice(0, room)}\n… <${dropped} bytes truncated>`;
};
export const buildRepairContext = (args) => {
    const maxBytes = args.maxBytes ?? DEFAULT_MAX;
    const header = `Repair round ${args.round}.`;
    let problem = args.problem;
    let diff = args.cumulativeDiff;
    let failTail = args.failTail;
    // Static overhead = headers + labels + next-steps + section separators.
    const compose = (p, d, f) => [
        header,
        "",
        HEADER_PROBLEM,
        p,
        "",
        HEADER_DIFF,
        d === "" ? "(no diff produced yet)" : d,
        "",
        HEADER_FAIL,
        f === "" ? "(no failure output captured)" : f,
        "",
        NEXT_STEPS,
    ].join("\n");
    // Shrink in priority order: failTail TAIL → diff middle → problem HEAD.
    // After each step, re-measure; stop early if under budget. Each section can
    // be trimmed AT MOST ONCE (its budget is the slack left after committing
    // higher-priority sections at their floors).
    const floors = { failTail: 64, diff: 128, problem: 64 };
    let out = compose(problem, diff, failTail);
    if (out.length <= maxBytes)
        return out;
    // Step 1: trim failTail to leave room for current diff+problem (or its floor).
    if (failTail !== "") {
        const otherDiff = diff.length > 0 ? diff.length : 0;
        const otherProblem = problem.length;
        const overhead = compose("", "", "").length + otherDiff + otherProblem;
        const room = Math.max(floors.failTail, maxBytes - overhead);
        failTail = trimTail(failTail, room);
    }
    out = compose(problem, diff, failTail);
    if (out.length <= maxBytes)
        return out;
    // Step 2: trim diff (keep `diff --git` headers + first+last hunks where possible).
    if (diff !== "") {
        const overhead = compose(problem, "", failTail).length;
        const room = Math.max(floors.diff, maxBytes - overhead);
        diff = truncateDiff(diff, room);
    }
    out = compose(problem, diff, failTail);
    if (out.length <= maxBytes)
        return out;
    // Step 3: trim problem (head-keep). Last resort.
    if (problem.length > floors.problem) {
        const overhead = compose("", diff, failTail).length;
        const room = Math.max(floors.problem, maxBytes - overhead);
        problem = trimHead(problem, room);
    }
    return compose(problem, diff, failTail);
};
const parseDiff = (diff) => {
    const files = [];
    let cur;
    let curHunk;
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            cur = { header: [line], hunks: [] };
            files.push(cur);
            curHunk = undefined;
            continue;
        }
        if (cur === undefined) {
            // Pre-`diff --git` preamble — synthetic file, no hunks.
            cur = { header: [line], hunks: [] };
            files.push(cur);
            continue;
        }
        if (line.startsWith("@@")) {
            curHunk = [line];
            cur.hunks.push(curHunk);
            continue;
        }
        if (curHunk !== undefined)
            curHunk.push(line);
        else
            cur.header.push(line);
    }
    return files;
};
const rebuildDiff = (files) => {
    const out = [];
    for (const f of files) {
        out.push(...f.header);
        if (f.hunks.length <= 2) {
            for (const h of f.hunks)
                out.push(...h);
            continue;
        }
        const first = f.hunks[0] ?? [];
        const last = f.hunks[f.hunks.length - 1] ?? [];
        const droppedHunks = f.hunks.length - 2;
        out.push(...first);
        out.push(`… <${droppedHunks} middle hunks truncated>`);
        out.push(...last);
    }
    return out.join("\n");
};
const headTailSqueeze = (s, target) => {
    const half = Math.max(128, Math.floor(target / 2) - 32);
    const head = s.slice(0, half);
    const tail = s.slice(-half);
    const dropped = s.length - head.length - tail.length;
    return `${head}\n… <${dropped} bytes truncated>\n${tail}`;
};
const truncateDiff = (diff, target) => {
    if (diff.length <= target)
        return diff;
    const rebuilt = rebuildDiff(parseDiff(diff));
    if (rebuilt.length <= target)
        return rebuilt;
    return headTailSqueeze(rebuilt, target);
};
