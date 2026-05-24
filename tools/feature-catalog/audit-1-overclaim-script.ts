#!/usr/bin/env bun
// Audit-1: verify overclaimed L4+ features against actual source
// READ-ONLY. Writes report to tools/feature-catalog/audit-1-overclaim-findings.md

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const FEATURES_DIR = join(ROOT, "tools/feature-catalog/features");

// 1) parse overclaimed table
const judgeOut = execSync("bun run tools/feature-catalog/cli.ts judge --overclaimed", {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 16 << 20,
});
const overclaimedIds: { id: string; section: string; maturity: string; composite: string; total: number }[] = [];
let inTable = false;
for (const line of judgeOut.split("\n")) {
  if (line.includes("id\tsection\tmaturity\tcomposite")) {
    inTable = true;
    continue;
  }
  if (!inTable) continue;
  if (!line.trim()) continue;
  if (line.startsWith("axis legend")) break;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 8) continue;
  overclaimedIds.push({
    id: parts[0],
    section: parts[1],
    maturity: parts[2],
    composite: parts[3],
    total: parseInt(parts[7], 10),
  });
}

// 2) build id->yaml-path map by walking features
const yamlByPath: Record<string, string> = {};
function walk(dir: string) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (ent.endsWith(".yaml")) yamlByPath[p] = readFileSync(p, "utf8");
  }
}
walk(FEATURES_DIR);

const yamlById: Record<string, { path: string; raw: string }> = {};
for (const [p, raw] of Object.entries(yamlByPath)) {
  const m = raw.match(/^id:\s*(\S+)/m);
  if (m) yamlById[m[1]] = { path: p, raw };
}

// helper: parse yaml fields (cheap regex-based — fine for these flat docs)
function parseYaml(raw: string) {
  const monitoring = (raw.match(/^monitoring:\s*(.+)$/m) || [])[1]?.trim() ?? "n-a";
  const uiSurfacesRaw = (raw.match(/^ui_surfaces:\s*\[(.+?)\]/m) || [])[1] ?? "n-a";
  const uiSurfaces = uiSurfacesRaw.split(",").map((s) => s.trim().replace(/['"]/g, ""));
  const codeMatch = raw.match(/code:\s*\[(.+?)\]/);
  const code = codeMatch ? codeMatch[1].split(",").map((s) => s.trim().replace(/['"]/g, "")) : [];
  // also handle block-style code (rare)
  const blockCode: string[] = [];
  const blockMatch = raw.match(/code:\n((?:\s+-\s+.+\n)+)/);
  if (blockMatch) {
    for (const ln of blockMatch[1].split("\n")) {
      const m = ln.match(/^\s+-\s+(.+)$/);
      if (m) blockCode.push(m[1].trim());
    }
  }
  const allCode = [...code, ...blockCode].filter((s) => s.length > 0 && s !== "n-a");

  // tests
  const unitMatch = raw.match(/unit:\s*\[(.+?)\]/);
  const intMatch = raw.match(/integration:\s*\[(.+?)\]/);
  const contractMatch = raw.match(/contract:\s*\[(.+?)\]/);
  const tests: string[] = [];
  for (const m of [unitMatch, intMatch, contractMatch]) {
    if (m) tests.push(...m[1].split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean));
  }
  return { monitoring, uiSurfaces, code: allCode, tests };
}

// 3) grep helper — bounded
function grepCount(pattern: string, file: string): number {
  if (!existsSync(file)) return -1;
  try {
    const out = execSync(`rg -c ${JSON.stringify(pattern)} ${JSON.stringify(file)} 2>/dev/null || true`, {
      cwd: ROOT,
      encoding: "utf8",
    });
    return parseInt(out.trim() || "0", 10) || 0;
  } catch {
    return 0;
  }
}

// 4) surface inference from path
function inferSurface(path: string): string {
  if (path.startsWith("src/apps/cli/") || path.startsWith("src/tool/")) return "cli";
  if (path.startsWith("src/ipc/") || path.startsWith("src/mcp/")) return "api";
  if (path.startsWith("src/lsp/")) return "ide";
  return "n-a";
}

// 5) audit loop — sample 80
const SAMPLE = 80;
// pick diverse: spread across sections
const bySection: Record<string, typeof overclaimedIds> = {};
for (const it of overclaimedIds) (bySection[it.section] ||= []).push(it);
const sectionKeys = Object.keys(bySection).sort();
const picked: typeof overclaimedIds = [];
let i = 0;
while (picked.length < SAMPLE) {
  let added = 0;
  for (const k of sectionKeys) {
    if (bySection[k][i]) {
      picked.push(bySection[k][i]);
      added++;
      if (picked.length >= SAMPLE) break;
    }
  }
  if (added === 0) break;
  i++;
}

type Row = {
  id: string;
  section: string;
  verdict: string;
  evidence: string;
  recommendation: string;
};
const rows: Row[] = [];
const counts: Record<string, number> = {
  "truly-overclaimed": 0,
  "mislabeled-monitoring": 0,
  "mislabeled-wiring": 0,
  "missing-tests": 0,
  "missing-evidence-code": 0,
  "appropriate-thin-not-overclaim": 0,
};

for (const it of picked) {
  const yml = yamlById[it.id];
  if (!yml) {
    rows.push({ id: it.id, section: it.section, verdict: "truly-overclaimed", evidence: "no-yaml-found", recommendation: "investigate-orphan-id" });
    counts["truly-overclaimed"]++;
    continue;
  }
  const meta = parseYaml(yml.raw);

  // existing-code paths
  const existingCode = meta.code.filter((p) => existsSync(join(ROOT, p)));
  const missingCode = meta.code.filter((p) => !existsSync(join(ROOT, p)));

  // monitoring axis grep across existing code
  let monMatches = 0;
  let wireMatches = 0;
  for (const p of existingCode) {
    monMatches += grepCount(
      "quanta\\.|gen_ai\\.|shell\\.exec\\.|recordAttrs|setAttribute|tracer\\.startSpan",
      join(ROOT, p),
    );
    wireMatches += grepCount("process\\.env\\.QUANTA_|runtimeConfig\\.", join(ROOT, p));
  }

  // surface inference
  const surfaces = new Set(existingCode.map((p) => inferSurface(p)));
  surfaces.delete("n-a");
  const claimedSurfaces = new Set(meta.uiSurfaces.filter((s) => s !== "n-a"));

  // test files matching id
  const idPat = it.id.replace(/[^a-zA-Z0-9-]/g, "");
  let testFilesFound: string[] = [];
  try {
    const out = execSync(
      `rg -l --files-with-matches '' tests/ 2>/dev/null | rg -i ${JSON.stringify(idPat.slice(0, 24))} 2>/dev/null | head -10 || true`,
      { cwd: ROOT, encoding: "utf8" },
    );
    testFilesFound = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {}
  const declaredTests = new Set(meta.tests);
  const undeclaredTests = testFilesFound.filter((t) => !declaredTests.has(t));

  // verdict matrix (priority order)
  let verdict = "appropriate-thin-not-overclaim";
  let evidence = "";
  let recommendation = "";

  if (existingCode.length === 0 && meta.code.length === 0) {
    verdict = "truly-overclaimed";
    evidence = "code:[] empty";
    recommendation = "downgrade-or-hold";
  } else if (existingCode.length === 0 && meta.code.length > 0) {
    verdict = "truly-overclaimed";
    evidence = `all-paths-missing:${meta.code.length}`;
    recommendation = "downgrade-or-fix-paths";
  } else if (monMatches > 0 && (meta.monitoring === "n-a" || meta.monitoring === "none" || meta.monitoring === "planned")) {
    verdict = "mislabeled-monitoring";
    evidence = `mon-grep=${monMatches} but monitoring=${meta.monitoring}`;
    recommendation = `set monitoring=integrated`;
  } else if (surfaces.size > 0 && claimedSurfaces.size === 0) {
    verdict = "mislabeled-wiring";
    evidence = `paths→${[...surfaces].join("|")} but ui_surfaces=${meta.uiSurfaces.join("|")}`;
    recommendation = `add ui_surfaces:[${[...surfaces].join(",")}]`;
  } else if (undeclaredTests.length > 0) {
    verdict = "missing-tests";
    evidence = `tests-on-disk-not-listed=${undeclaredTests.slice(0, 2).join(";")}`;
    recommendation = "add to evidence.tests.unit";
  } else if (missingCode.length > 0) {
    verdict = "missing-evidence-code";
    evidence = `stale-paths=${missingCode.length}`;
    recommendation = "fix stale code paths";
  } else {
    verdict = "appropriate-thin-not-overclaim";
    evidence = `code=${existingCode.length} mon=${monMatches} wire=${wireMatches}`;
    recommendation = "thin axes are correct (not overclaim)";
  }

  counts[verdict] = (counts[verdict] || 0) + 1;
  rows.push({ id: it.id, section: it.section, verdict, evidence, recommendation });
}

// 6) write report
const lines: string[] = [];
lines.push("# Audit-1: Overclaim Verification Report");
lines.push("");
lines.push(`Date: 2026-05-24`);
lines.push(`Total overclaimed flagged by \`fc judge\`: ${overclaimedIds.length}`);
lines.push(`Sample audited: ${rows.length}`);
lines.push("");
lines.push("## Verdict counts");
lines.push("");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  lines.push(`- **${k}**: ${v}`);
}
lines.push("");
lines.push("## Findings (per-feature)");
lines.push("");
lines.push("| feature-id | section | verdict | grep-evidence | recommendation |");
lines.push("|---|---|---|---|---|");
for (const r of rows) {
  lines.push(`| ${r.id} | ${r.section} | ${r.verdict} | ${r.evidence} | ${r.recommendation} |`);
}
lines.push("");
lines.push("## Method");
lines.push("");
lines.push("- Source: `bun run tools/feature-catalog/cli.ts judge --overclaimed`");
lines.push("- Per-feature: yaml parsed → existing evidence.code → rg counts for OTel/recordAttrs/startSpan and runtimeConfig/env");
lines.push("- Surface inferred from path prefix (cli/api/ide); compared to yaml ui_surfaces");
lines.push("- Tests on disk matched by id substring; compared to evidence.tests.{unit,integration,contract}");
lines.push("- Verdict matrix applied in priority order; no heuristics beyond grep counts");

const reportPath = join(ROOT, "tools/feature-catalog/audit-1-overclaim-findings.md");
import("node:fs").then((fs) => fs.writeFileSync(reportPath, lines.join("\n")));

console.log(JSON.stringify(counts, null, 2));
console.log(`\nReport: ${reportPath}`);
console.log(`Sample size: ${rows.length}`);
