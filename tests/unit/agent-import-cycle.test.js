import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const AGENT_DIR = join(import.meta.dir, "..", "..", "src", "agent");
const WHITELIST = [["conversation-action.ts", "steering.ts"]];
const parseImports = (src, agentFiles) => {
  const out = [];
  const rawLines = src.split(/\r?\n/);
  for (let i = 0;i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    if (!/^\s*(import|export)\b/.test(raw))
      continue;
    let stitched = raw;
    let j = i;
    while (!/from\s+["'][^"']+["']\s*;?\s*$/.test(stitched) && /\bfrom\b/.test(stitched) === false && j < rawLines.length - 1) {
      j++;
      stitched += ` ${(rawLines[j] ?? "").trim()}`;
    }
    const sideEffect = stitched.match(/^\s*import\s+["']([^"']+)["']/);
    if (sideEffect) {
      const target = resolveRelTarget(sideEffect[1] ?? "", agentFiles);
      out.push({ target, line: i + 1, typeOnly: false, valueNames: [] });
      continue;
    }
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
      valueNames: extractValueNames(symbolsBlob, isTypeOnly)
    });
  }
  return out;
};
const resolveRelTarget = (spec, agentFiles) => {
  if (!spec.startsWith("./"))
    return null;
  const tail = spec.slice(2);
  const direct = `${tail}.ts`;
  if (agentFiles.has(direct))
    return direct;
  if (agentFiles.has(tail))
    return tail;
  return null;
};
const extractValueNames = (blob, typeOnly) => {
  if (typeOnly)
    return [];
  const ns = blob.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (ns)
    return [`*:${ns[1]}`];
  const brace = blob.match(/\{([^}]*)\}/);
  if (!brace) {
    const def = blob.trim().match(/^([A-Za-z_$][\w$]*)$/);
    return def ? [`default:${def[1]}`] : [];
  }
  const inside = brace[1] ?? "";
  const parts = inside.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  const names = [];
  const beforeBrace = blob.slice(0, blob.indexOf("{")).trim().replace(/,$/, "").trim();
  const defM = beforeBrace.match(/^([A-Za-z_$][\w$]*)$/);
  if (defM)
    names.push(`default:${defM[1]}`);
  for (const p of parts) {
    if (/^type\s+/.test(p))
      continue;
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
const listAgentFiles = () => {
  const all = readdirSync(AGENT_DIR);
  return all.filter((n) => n.endsWith(".ts")).filter((n) => {
    try {
      return statSync(join(AGENT_DIR, n)).isFile();
    } catch {
      return false;
    }
  }).sort();
};
const findSCCs = (nodes, edges) => {
  let index = 0;
  const idx = new Map;
  const low = new Map;
  const onStack = new Set;
  const stack = [];
  const sccs = [];
  const strongconnect = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? new Set) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
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
const stripComments = (src) => {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim());
};
const toLocalName = (n) => {
  if (n.startsWith("default:"))
    return n.slice("default:".length);
  if (n.startsWith("*:"))
    return n.slice("*:".length);
  return n;
};
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
  for (let i = 0;i < stripped.length; i++) {
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
  const parsed = new Map;
  for (const f of files) {
    const src = readFileSync(join(AGENT_DIR, f), "utf8");
    parsed.set(f, parseImports(src, fileSet));
  }
  test("known cycles are exactly the whitelisted ones", () => {
    const edges = new Map;
    for (const f of files)
      edges.set(f, new Set);
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
    for (const k of sccKeys) {
      expect(whiteKeys, `unknown value-level import cycle detected: ${k}
If this is intentional and reviewed, add it to WHITELIST in tests/unit/agent-import-cycle.test.ts and ensure every edge in the ring stays runtime-lazy (no module-top-level calls into the cycle).`).toContain(k);
    }
    for (const k of whiteKeys) {
      expect(sccKeys, `whitelisted cycle no longer present: ${k}
` + `Refactor removed the cycle \u2014 drop the entry from WHITELIST.`).toContain(k);
    }
  });
  test("every edge inside a whitelisted cycle is runtime-lazy (no module-top usage)", () => {
    const inWhitelist = new Set;
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
        const hits = findTopLevelUsage(src, imp.valueNames);
        expect(hits, `${f}:${imp.line}: module-top-level use of symbol(s) from ./${imp.target} would deadlock the known cycle.
Offending references: ${hits.map((h) => `${h.name}@L${h.line}`).join(", ")}.
Fix: only call/reference these symbols from inside a function body.`).toEqual([]);
      }
    }
  });
});
