import { safeRun, stderrReason } from "./_shared";
import { gitStatusInputSchema } from "./types";
/** Map a porcelain v2 XY pair (X = index status, Y = worktree status) to a
 *  short human note. Codes per `git status --porcelain=v2` docs:
 *    '.' = unmodified, M = modified, A = added, D = deleted, R = renamed,
 *    C = copied, U = updated-but-unmerged, T = type-change. */
const xyNote = (x, y) => {
    const notes = [];
    const stagedChange = x !== "." && x !== " ";
    const worktreeChange = y !== "." && y !== " ";
    const label = (c) => {
        switch (c) {
            case "M":
                return "modified";
            case "A":
                return "added";
            case "D":
                return "deleted";
            case "R":
                return "renamed";
            case "C":
                return "copied";
            case "U":
                return "unmerged";
            case "T":
                return "type-changed";
            default:
                return "";
        }
    };
    if (stagedChange) {
        const l = label(x);
        if (l)
            notes.push(`${l}, staged`);
    }
    if (worktreeChange) {
        const l = label(y);
        if (l)
            notes.push(`${l}, unstaged`);
    }
    return notes.join("; ");
};
const parseHeader = (line, out) => {
    if (line.startsWith("# branch.head ")) {
        out.branch = line.slice("# branch.head ".length).trim();
        return;
    }
    if (line.startsWith("# branch.ab ")) {
        const rest = line.slice("# branch.ab ".length).trim();
        const m = /^\+(\d+)\s+-(\d+)$/.exec(rest);
        if (m?.[1] && m[2]) {
            out.ahead = Number(m[1]);
            out.behind = Number(m[2]);
        }
    }
};
const parseChangedEntry = (line) => {
    // Ordinary: "1 XY sub mh mi mw hh hi path"
    // Rename:   "2 XY sub mh mi mw hh hi score path\torigpath"
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    const x = xy.charAt(0);
    const y = xy.charAt(1);
    const path = line.startsWith("2 ")
        ? (parts.slice(9).join(" ").split("\t")[0] ?? "")
        : parts.slice(8).join(" ");
    return { code: ` ${xy} `, path, note: xyNote(x, y) || "changed" };
};
const parseUnmerged = (line) => {
    // "u XY sub m1 m2 m3 mw h1 h2 h3 path"
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    const path = parts.slice(10).join(" ");
    return { code: ` ${xy} `, path, note: "unmerged" };
};
const parseEntry = (line) => {
    if (line.startsWith("1 ") || line.startsWith("2 "))
        return parseChangedEntry(line);
    if (line.startsWith("u "))
        return parseUnmerged(line);
    if (line.startsWith("? "))
        return { code: " ?? ", path: line.slice(2), note: "untracked" };
    if (line.startsWith("! "))
        return { code: " !! ", path: line.slice(2), note: "ignored" };
    return null;
};
const parsePorcelainV2 = (stdout) => {
    const out = { branch: "(detached)", ahead: 0, behind: 0, files: [] };
    for (const line of stdout.split("\n")) {
        if (!line)
            continue;
        if (line.startsWith("# ")) {
            parseHeader(line, out);
            continue;
        }
        const entry = parseEntry(line);
        if (entry)
            out.files.push(entry);
    }
    return out;
};
const formatStatus = (p) => {
    const head = `Branch: ${p.branch} (ahead ${p.ahead}, behind ${p.behind})`;
    if (p.files.length === 0) {
        return `Branch: ${p.branch}\n(working tree clean)`;
    }
    const rows = p.files.map((f) => `${f.code} ${f.path}  (${f.note})`);
    return `${head}\n${rows.join("\n")}`;
};
export const gitStatusTool = (runner) => ({
    name: "git_status",
    description: "Show working tree status (branch + per-file modification flags).",
    inputSchema: gitStatusInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(_input, ctx) {
        yield { type: "progress", message: "git status" };
        const out = await safeRun(runner, ["status", "--porcelain=v2", "--branch"], ctx.cwd, "git status", ctx.signal);
        if (out.kind === "spawn-error") {
            yield { type: "result", result: { ok: false, output: out.message } };
            return;
        }
        const r = out.result;
        if (r.exitCode !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: stderrReason(r.stderr, r.exitCode, "git status") },
            };
            return;
        }
        yield {
            type: "result",
            result: { ok: true, output: formatStatus(parsePorcelainV2(r.stdout)) },
        };
    },
});
