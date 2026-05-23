import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const unquote = (v) => (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v;
/** Parse one `KEY=VALUE` line into a pair, or null for blanks/comments/invalid.
 *  A leading `export ` prefix (common when a `.env` doubles as a shell-source
 *  file) is stripped so `export FOO=bar` yields key `FOO`, not `export FOO`. */
const parseLine = (raw) => {
    let line = raw.trim();
    if (line === "" || line.startsWith("#"))
        return null;
    if (line.startsWith("export "))
        line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0)
        return null;
    return [line.slice(0, eq).trim(), unquote(line.slice(eq + 1).trim())];
};
const loadOne = (path) => {
    if (!existsSync(path))
        return;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
        const pair = parseLine(raw);
        if (pair && process.env[pair[0]] === undefined)
            process.env[pair[0]] = pair[1];
    }
};
/** Load `KEY=VALUE` files into process.env without overriding values already
 *  set in the real environment. Tiny by design — no dotenv dependency.
 *  Later files do NOT override earlier ones (first wins, like real env). */
export const loadEnvFiles = (files) => {
    for (const file of files)
        loadOne(resolve(process.cwd(), file));
};
