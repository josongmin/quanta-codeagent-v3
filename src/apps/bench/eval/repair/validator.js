const DEFAULT_TAIL = 2000;
export const validate = async (args) => {
    const tailBound = args.tailBytes ?? DEFAULT_TAIL;
    const cmd = pickCmd(args);
    if (cmd === undefined) {
        // No agent-supplied signal — return a degenerate failure so the outer
        // loop can still iterate or terminate, but never silently "pass".
        return { ok: false, failTail: "" };
    }
    const r = await args.exec(cmd, args.sandbox, args.timeoutMs);
    if (r.code === 0)
        return { ok: true };
    const combined = `${r.stdout}\n${r.stderr}`;
    const failTail = combined.length > tailBound ? combined.slice(-tailBound) : combined;
    return { ok: false, failTail };
};
const pickCmd = (args) => {
    const cmd = args.cmd ?? "";
    if (cmd !== "")
        return cmd;
    const repro = args.reproPath ?? "";
    if (repro !== "")
        return `python "${repro}"`;
    return undefined;
};
