/**
 * Static guard against module-init deadlocks in `src/agent/*.ts`.
 *
 * ## Background
 * `src/agent/` has a known value-level import cycle, tolerated because the
 * cross-edge values (`runAgent`, `createSubagentRunner`, `buildBranchSearch
 * Tool`, `buildSessionFeatures`) are ONLY referenced at runtime — never
 * evaluated at module top-level. The cycle as a single strongly-connected
 * component is:
 *
 *   { features.ts, loop.ts, subagent-runner.ts, branch-search-runner.ts }
 *
 * Conceptually this is two overlapping rings sharing the loop↔features edge:
 *
 *   (1) features.ts → subagent-runner.ts → loop.ts → features.ts
 *   (2) features.ts → branch-search-runner.ts → loop.ts → features.ts
 *
 * Tarjan collapses them into one SCC; we whitelist the SCC, not each ring.
 * Future ESM-aware bundlers (or a stray module-top-level call) could turn the
 * cycle into a deadlock — this test seals the invariant.
 *
 * ## What this test enforces
 * - Build the value-import graph of `src/agent/*.ts` (TS-files only, not
 *   subdirectories — those don't form cycles with `loop.ts` today).
 * - Find every strongly-connected component of size ≥ 2 (Tarjan).
 * - Fail loudly when:
 *     (a) a SCC contains files NOT on the known whitelist, OR
 *     (b) the known whitelist contains files NOT in any found SCC (drift in
 *         the opposite direction — refactor removed the cycle but forgot to
 *         relax the guard), OR
 *     (c) any edge inside a whitelisted SCC's ring uses the imported symbol
 *         at module top-level (synchronous, outside a function body) — that
 *         IS the deadlock condition.
 *
 * ## What counts as a "value edge"
 * - `import type { ... } from "./x"`         — IGNORED (type-only, erased).
 * - `import { type Foo } from "./x"`         — counted as value-edge
 *                                              (mixed; we're conservative).
 * - `import { foo } from "./x"`              — value-edge.
 * - `import foo from "./x"`                  — value-edge (default).
 * - `import "./x"`                           — value-edge (side-effect).
 * - `export { foo } from "./x"`              — value-edge (re-export).
 * - `export type { Foo } from "./x"`         — IGNORED.
 *
 * Subdirectory imports (`from "./branch-search"`, `from "./run-mode/..."`)
 * are tracked as separate "external" nodes that can never form a cycle with
 * the top-level files (they're directories, not files in this graph).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const AGENT_DIR = join(import.meta.dir, "..", "..", "src", "agent");
/** Whitelisted SCCs: the known + reviewed value cycles. Sorted alphabetically
 *  for stable comparison; the SCC finder also sorts each component before
 *  emitting it.
 *
 *  Entry 1 — `loop` ring (collapses subagent-runner + branch-search-runner
 *    rings; they share the loop↔features edge). Safe because every cross-
 *    edge symbol (`runAgent`, `createSubagentRunner`, `buildBranchSearch
 *    Tool`, `buildSessionFeatures`) is only called inside function bodies.
 *
 *  Entry 2 — `steering ↔ conversation-action` ring. `conversation-action.ts`
 *    imports `steer` / `SteerInputInvalidError` for use inside `decideAction`;
 *    `steering.ts` re-exports the conversation-action surface as a one-stop
 *    barrel. Safe because every reference lives in a function body. */
const WHITELIST = [
    ["branch-search-runner.ts", "features.ts", "loop.ts", "subagent-runner.ts"],
    ["conversation-action.ts", "steering.ts"],
];
/** Parse the import/export lines of a `.ts` source. Single-line regex pass;
 *  multi-line imports are uncommon in this codebase but we still handle the
 *  trivial `\n`-joined form by collapsing whitespace within a candidate. */
const parseImports = (src, agentFiles) => {
    const out = [];
    // Collapse multi-line `import { ... }` blocks into single logical lines by
    // joining continuation lines until a closing brace + `from "..."` is seen.
    // For this codebase a single-line regex over the original text plus a
    // multi-line fallback is sufficient.
    const rawLines = src.split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i] ?? "";
        if (!/^\s*(import|export)\b/.test(raw))
            continue;
        // Stitch a multi-line import together (read forward until we hit `from "..."` or `;`).
        let stitched = raw;
        let j = i;
        while (!/from\s+["'][^"']+["']\s*;?\s*$/.test(stitched) &&
            /\bfrom\b/.test(stitched) === false &&
            j < rawLines.length - 1) {
            j++;
            stitched += ` ${(rawLines[j] ?? "").trim()}`;
        }
        // Side-effect import: `import "./x"` (no symbols, no `from`).
        const sideEffect = stitched.match(/^\s*import\s+["']([^"']+)["']/);
        if (sideEffect) {
            const target = resolveRelTarget(sideEffect[1] ?? "", agentFiles);
            out.push({ target, line: i + 1, typeOnly: false, valueNames: [] });
            continue;
        }
        // `import [type] ... from "..."` or `export [type] {..} from "..."`.
        const m = stitched.match(/^\s*(import|export)\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["']/);
        if (!m)
            continue;
        const isTypeOnly = (m[2] ?? "").trim() === "type";
        const symbolsBlob = m[3] ?? "";
        const spec = m[4] ?? "";
        const target = resolveRelTarget(spec, agentFiles);
        out.push({
            target,
            line: i + 1,
            typeOnly: isTypeOnly,
            valueNames: extractValueNames(symbolsBlob, isTypeOnly),
        });
    }
    return out;
};
/** Resolve `./x` style specifiers to a file in `agentFiles`, or `null`. */
const resolveRelTarget = (spec, agentFiles) => {
    if (!spec.startsWith("./"))
        return null;
    const tail = spec.slice(2);
    // Direct `.ts` neighbor?
    const direct = `${tail}.ts`;
    if (agentFiles.has(direct))
        return direct;
    // Already includes the extension (rare in this codebase but harmless).
    if (agentFiles.has(tail))
        return tail;
    // Otherwise: subdirectory or `index` re-export — treat as external for the
    // purpose of cycle detection across the flat `src/agent/*.ts` graph.
    return null;
};
/** Pull out the named value symbols from the brace blob (between `{` and `}`).
 *  Skip names individually marked `type` (mixed imports like
 *  `import { type Foo, bar }`). For `import X from "..."` (default), return
 *  `["default:X"]`. For `import * as ns from "..."`, return `["*:ns"]`.
 *  When the whole import is `type`-only, return `[]`. */
const extractValueNames = (blob, typeOnly) => {
    if (typeOnly)
        return [];
    const ns = blob.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns)
        return [`*:${ns[1]}`];
    const brace = blob.match(/\{([^}]*)\}/);
    if (!brace) {
        // Pure default import: `import X from "..."` — `blob` is `X` (possibly
        // with leading whitespace).
        const def = blob.trim().match(/^([A-Za-z_$][\w$]*)$/);
        return def ? [`default:${def[1]}`] : [];
    }
    const inside = brace[1] ?? "";
    const parts = inside
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    const names = [];
    // Default companion before the brace: `import X, { y } from "..."`.
    const beforeBrace = blob.slice(0, blob.indexOf("{")).trim().replace(/,$/, "").trim();
    const defM = beforeBrace.match(/^([A-Za-z_$][\w$]*)$/);
    if (defM)
        names.push(`default:${defM[1]}`);
    for (const p of parts) {
        if (/^type\s+/.test(p))
            continue; // erased
        // `foo as bar` ⇒ local binding is `bar`.
        const aliased = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (aliased) {
            names.push(aliased[2] ?? "");
            continue;
        }
        const plain = p.match(/^([A-Za-z_$][\w$]*)$/);
        if (plain)
            names.push(plain[1] ?? "");
    }
    return names.filter((n) => n.length > 0);
};
/** Enumerate `*.ts` files in `src/agent/` (top-level only). */
const listAgentFiles = () => {
    const all = readdirSync(AGENT_DIR);
    return all
        .filter((n) => n.endsWith(".ts"))
        .filter((n) => {
        try {
            return statSync(join(AGENT_DIR, n)).isFile();
        }
        catch {
            return false;
        }
    })
        .sort();
};
/** Tarjan's SCC: returns SCCs of size ≥ 2 only (we don't care about
 *  self-loops here; none exist in TS imports anyway). Each SCC's nodes are
 *  sorted alphabetically for deterministic comparison. */
const findSCCs = (nodes, edges) => {
    let index = 0;
    const idx = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];
    const strongconnect = (v) => {
        idx.set(v, index);
        low.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);
        for (const w of edges.get(v) ?? new Set()) {
            if (!idx.has(w)) {
                strongconnect(w);
                low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
            }
            else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0));
            }
        }
        if ((low.get(v) ?? 0) === (idx.get(v) ?? 0)) {
            const comp = [];
            let w;
            do {
                w = stack.pop();
                if (w === undefined)
                    break;
                onStack.delete(w);
                comp.push(w);
            } while (w !== v);
            if (comp.length >= 2)
                sccs.push(comp.sort());
        }
    };
    for (const v of nodes)
        if (!idx.has(v))
            strongconnect(v);
    return sccs.sort((a, b) => a.join(",").localeCompare(b.join(",")));
};
/** Heuristic top-level-usage scanner. For each `name` we want to ensure it is
 *  NOT referenced at module top-level (outside any function/class/arrow body).
 *  We approximate by tracking brace depth: depth 0 = module top-level. Within
 *  a depth-0 statement, a token match for `name` followed by `(` is a
 *  module-top-level call (the deadlock condition). A bare reference at depth
 *  0 (e.g. `export const X = name`) is also flagged — referencing the binding
 *  at module-eval still forces the other module to finish initializing.
 *  Type-position usage (after `:` until the next `=` / `,` / `;` / `)` at the
 *  same depth) is ignored.
 *
 *  This is approximate (no AST) but is good enough for a guardrail: false
 *  positives can be addressed by giving the binding a private alias used
 *  only inside a function body. */
/** Strip both `/* ... *\/` block comments and `// ...` line comments while
 *  preserving line numbers (each stripped char is replaced with a space; only
 *  newlines survive). Critical: naive per-line stripping misses doc-comments
 *  that span lines, leading to false-positive hits on doc-comment tokens. */
const stripComments = (src) => {
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    return noBlock.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim());
};
/** Translate name decorations (`default:X` / `*:ns`) back to the local binding
 *  identifier visible in the source. */
const toLocalName = (n) => {
    if (n.startsWith("default:"))
        return n.slice("default:".length);
    if (n.startsWith("*:"))
        return n.slice("*:".length);
    return n;
};
/** Update brace/paren/bracket depth across one line's characters. Returns the
 *  depth AFTER the line. */
const advanceDepth = (line, depth) => {
    let d = depth;
    for (const ch of line) {
        if (ch === "{" || ch === "(" || ch === "[")
            d++;
        else if (ch === "}" || ch === ")" || ch === "]")
            d = Math.max(0, d - 1);
    }
    return d;
};
const findTopLevelUsage = (src, names) => {
    if (names.length === 0)
        return [];
    const stripped = stripComments(src);
    const localNames = names.map(toLocalName);
    const hits = [];
    let depth = 0;
    let inImport = false;
    let inExportType = false;
    for (let i = 0; i < stripped.length; i++) {
        const line = stripped[i] ?? "";
        if (depth === 0 && /^(import|export)\b/.test(line)) {
            inImport = true;
            inExportType = /^export\s+type\b/.test(line);
        }
        const before = depth;
        depth = advanceDepth(line, depth);
        if (inImport && /\bfrom\b/.test(line) && /["'][^"']+["']/.test(line)) {
            inImport = false;
            inExportType = false;
            continue;
        }
        if (inImport || inExportType)
            continue;
        // Flag only when statement lives entirely at module top-level (depth 0
        // before AND after) — avoids false-positives on `const f = () => { ... }`.
        if (before !== 0 || depth !== 0)
            continue;
        for (const n of localNames) {
            const re = new RegExp(`(^|[^\\w.])${escapeReg(n)}(?![\\w$])`);
            if (re.test(line))
                hits.push({ name: n, line: i + 1 });
        }
    }
    return hits;
};
const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
describe("agent module import cycles", () => {
    const files = listAgentFiles();
    const fileSet = new Set(files);
    // Build the parsed-imports table once.
    const parsed = new Map();
    for (const f of files) {
        const src = readFileSync(join(AGENT_DIR, f), "utf8");
        parsed.set(f, parseImports(src, fileSet));
    }
    test("known cycles are exactly the whitelisted ones", () => {
        const edges = new Map();
        for (const f of files)
            edges.set(f, new Set());
        for (const [f, imps] of parsed) {
            const set = edges.get(f);
            if (!set)
                continue;
            for (const imp of imps) {
                if (imp.typeOnly)
                    continue;
                if (imp.target === null)
                    continue;
                if (imp.target === f)
                    continue;
                set.add(imp.target);
            }
        }
        const sccs = findSCCs(files, edges);
        const sccKeys = sccs.map((s) => s.join(","));
        const whiteKeys = WHITELIST.map((w) => [...w].sort().join(","));
        // (a) no unknown SCC
        for (const k of sccKeys) {
            expect(whiteKeys, `unknown value-level import cycle detected: ${k}\n` +
                `If this is intentional and reviewed, add it to WHITELIST in ` +
                `tests/unit/agent-import-cycle.test.ts and ensure every edge in the ` +
                `ring stays runtime-lazy (no module-top-level calls into the cycle).`).toContain(k);
        }
        // (b) no stale whitelist entry
        for (const k of whiteKeys) {
            expect(sccKeys, `whitelisted cycle no longer present: ${k}\n` +
                `Refactor removed the cycle — drop the entry from WHITELIST.`).toContain(k);
        }
    });
    test("every edge inside a whitelisted cycle is runtime-lazy (no module-top usage)", () => {
        // For every value-import in a whitelisted SCC, verify the imported
        // symbols are not referenced at module top-level in the importing file.
        const inWhitelist = new Set();
        for (const w of WHITELIST)
            for (const n of w)
                inWhitelist.add(n);
        for (const [f, imps] of parsed) {
            if (!inWhitelist.has(f))
                continue;
            const src = readFileSync(join(AGENT_DIR, f), "utf8");
            for (const imp of imps) {
                if (imp.typeOnly)
                    continue;
                if (imp.target === null)
                    continue;
                if (!inWhitelist.has(imp.target))
                    continue;
                // This edge is INSIDE one of the rings — scan for top-level use.
                const hits = findTopLevelUsage(src, imp.valueNames);
                expect(hits, `${f}:${imp.line}: module-top-level use of symbol(s) from ` +
                    `./${imp.target} would deadlock the known cycle.\n` +
                    `Offending references: ${hits.map((h) => `${h.name}@L${h.line}`).join(", ")}.\n` +
                    `Fix: only call/reference these symbols from inside a function body.`).toEqual([]);
            }
        }
    });
});
