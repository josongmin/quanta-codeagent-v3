export const runRepairRounds = async (args) => {
    const maxRounds = args.config.maxRounds ?? 2;
    const history = [];
    // Round 0: initial attempt — seed is undefined so the runner uses its
    // existing problem message construction unchanged.
    const r0 = await args.runOnce(undefined);
    const v0 = await runValidate(args, r0);
    let turnsTotal = r0.turns;
    history.push({ round: 0, patch: r0.patch, validated: v0.ok });
    if (v0.ok || maxRounds <= 0) {
        return finalize(history, turnsTotal, v0.ok, r0.patch);
    }
    let prevRun = r0;
    let prevValidator = v0;
    let validated = false;
    for (let i = 1; i <= maxRounds; i++) {
        const seed = args.buildContext({
            problem: args.problem,
            cumulativeDiff: prevRun.patch,
            failTail: prevValidator.failTail ?? "",
            round: i,
        });
        const ri = await args.runOnce(seed);
        const vi = await runValidate(args, ri);
        turnsTotal += ri.turns;
        history.push({ round: i, patch: ri.patch, validated: vi.ok });
        prevRun = ri;
        prevValidator = vi;
        if (vi.ok) {
            validated = true;
            break;
        }
    }
    return finalize(history, turnsTotal, validated, prevRun.patch);
};
const runValidate = (args, r) => {
    // exactOptionalPropertyTypes: conditionally include optional fields only when
    // present — never set them to explicit `undefined`.
    const validateArgs = {
        sandbox: args.sandbox,
        exec: args.exec,
        timeoutMs: args.timeoutMs,
        ...(r.lastVerifyCmd !== undefined ? { cmd: r.lastVerifyCmd } : {}),
        ...(r.reproPath !== undefined ? { reproPath: r.reproPath } : {}),
    };
    return args.validate(validateArgs);
};
const finalize = (history, turns, validated, patch) => ({
    patch,
    turns,
    rounds: history.length,
    validated,
    history,
});
