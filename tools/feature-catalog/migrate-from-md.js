#!/usr/bin/env bun
/**
 * Feature-catalog migration: docs/10.feature-catalog.md -> thin YAML files.
 *
 * One-shot migration. Best-effort parse; humans review output afterward.
 * Pure Bun script (no deps beyond stdlib). exactOptionalPropertyTypes compatible.
 *
 * Usage:
 *   bun tools/feature-catalog/migrate-from-md.ts --dry     # stats to stdout only
 *   bun tools/feature-catalog/migrate-from-md.ts --write   # actually write files
 *
 * Schema (CANONICAL): see migration spec. Key order in YAML is stable:
 *   id, title, section, subsystem, order, maturity, status,
 *   purpose, evidence, knobs, deliberate_hold, notes.
 *
 * TODO: when tools/feature-catalog/yaml.ts exists with stringifyYaml,
 *   replace the inline stringifyYaml() below with import { stringifyYaml }
 *   from "./yaml.ts" for round-trip parity.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringifyYaml } from "./yaml";
// ---------- Constants ----------
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SOURCE_MD = join(REPO_ROOT, "docs", "10.feature-catalog.md");
const OUT_DIR = join(REPO_ROOT, "tools", "feature-catalog", "features");
const SECTION_SLUGS = {
    1: "01-agent-loop",
    2: "02-tool-system",
    3: "03-permission-safety",
    4: "04-context-management",
    5: "05-memory",
    6: "06-tier1",
    7: "07-resilience",
    8: "08-observability",
    9: "09-integration",
    10: "10-app",
};
const HOLD_KEYWORDS = ["미흡수", "의도적 보류", "intentional hold", "보류"];
// ---------- Args ----------
const args = process.argv.slice(2);
const dryRun = args.includes("--dry");
const write = args.includes("--write");
if (!dryRun && !write) {
    process.stderr.write("usage: bun migrate-from-md.ts [--dry | --write]\n");
    process.exit(2);
}
// ---------- Parse ----------
function readSourceMd() {
    return readFileSync(SOURCE_MD, "utf-8");
}
/** Split MD into section blocks keyed by section number. */
function splitSections(md) {
    const sections = new Map();
    // Match "## 대 N." headers; capture section number + header line.
    const re = /^## 대 (\d+)\.\s*(.*)$/gm;
    const matches = [];
    for (const m of md.matchAll(re)) {
        const n = Number.parseInt(m[1] ?? "", 10);
        if (!Number.isFinite(n) || m.index === undefined)
            continue;
        matches.push({ section: n, header: m[2] ?? "", index: m.index });
    }
    for (let i = 0; i < matches.length; i++) {
        const cur = matches[i];
        if (!cur)
            continue;
        const next = matches[i + 1];
        const end = next ? next.index : md.length;
        const body = md.slice(cur.index, end);
        sections.set(cur.section, { header: cur.header, body });
    }
    return sections;
}
/** Split a single pipe-row into trimmed cells.
 *  Respects backslash-escaped pipes (`\|`) inside cell content. */
function splitTableCells(trimmedLine) {
    const cells = [];
    let cur = "";
    for (let i = 0; i < trimmedLine.length; i++) {
        const ch = trimmedLine[i];
        if (ch === "\\" && trimmedLine[i + 1] === "|") {
            // Preserve literal pipe inside a cell
            cur += "|";
            i++;
            continue;
        }
        if (ch === "|") {
            cells.push(cur.trim());
            cur = "";
            continue;
        }
        cur += ch;
    }
    cells.push(cur.trim());
    // Drop the leading and trailing empties created by surrounding pipes.
    return cells.slice(1, -1);
}
/** True if this row is a column-title header (e.g. "중 | 소 | 등급"). */
function isHeaderTitleRow(cells) {
    return (cells[0] === "중" ||
        cells[0] === "등급" ||
        (cells[0] === "" && cells[1] === "소" && cells[2] === "등급"));
}
/** Parse the markdown table from a section body into rows.
 *  Tables use pipe-delimited rows; skip header and divider lines. */
function parseTable(sectionBody) {
    const lines = sectionBody.split("\n");
    const rows = [];
    let inTable = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) {
            inTable = false;
            continue;
        }
        if (/^\|[\s|:-]+\|$/.test(trimmed)) {
            inTable = true;
            continue;
        }
        if (!inTable)
            continue;
        const cells = splitTableCells(trimmed);
        if (cells.length < 3)
            continue;
        if (isHeaderTitleRow(cells))
            continue;
        rows.push({
            cellMid: cells[0] ?? "",
            cellSmall: cells[1] ?? "",
            cellGrade: cells[2] ?? "",
        });
    }
    return rows;
}
/** Extract maturity (L1-L5) from grade cell. Defaults to L3 if missing. */
function extractMaturity(gradeCell) {
    const m = gradeCell.match(/L([1-5])/);
    if (!m)
        return "L3";
    return `L${m[1]}`;
}
/** Extract first bold or first phrase from "소" cell as title. */
function extractTitle(smallCell) {
    // Strip leading numeric markers like "1.1" (kept in subsystem if present)
    const cleaned = smallCell.replace(/^`?[\d.]+`?\s*[가-힣A-Za-z]*\s*\|?\s*/, "");
    // Try first **bold** segment
    const bold = smallCell.match(/\*\*([^*]+)\*\*/);
    if (bold?.[1]) {
        return bold[1].trim().slice(0, 80);
    }
    // First backtick segment
    const code = smallCell.match(/`([^`]+)`/);
    if (code?.[1]) {
        return code[1].trim().slice(0, 80);
    }
    // First sentence-ish chunk (split on common delimiters)
    const first = cleaned.split(/[—,·.:([]/)[0] ?? cleaned;
    const compact = first.replace(/\s+/g, " ").trim();
    return (compact || smallCell.slice(0, 40)).slice(0, 80);
}
/** Extract subsystem (mid cell) — stripping any leading numeric prefix like "1.1 ". */
function extractSubsystem(midCell) {
    return midCell.replace(/^[\d.]+\s+/, "").trim();
}
/** Extract code paths under src/. */
function extractCodePaths(body) {
    const set = new Set();
    const re = /src\/[A-Za-z0-9_\-./]+\.(?:ts|tsx|mjs|js)/g;
    for (const m of body.matchAll(re)) {
        set.add(m[0].replace(/[.,)\]:]+$/, ""));
    }
    return [...set].sort();
}
function extractTestPaths(body) {
    const unit = new Set();
    const integ = new Set();
    const contract = new Set();
    const re = /tests\/(unit|integration|contract)\/[A-Za-z0-9_\-./]+\.test\.ts/g;
    for (const m of body.matchAll(re)) {
        const cleaned = m[0].replace(/[.,)\]:]+$/, "");
        if (m[1] === "unit")
            unit.add(cleaned);
        else if (m[1] === "integration")
            integ.add(cleaned);
        else if (m[1] === "contract")
            contract.add(cleaned);
    }
    return {
        unit: [...unit].sort(),
        integration: [...integ].sort(),
        contract: [...contract].sort(),
    };
}
function addAdrIfValid(set, raw) {
    if (raw === undefined)
        return;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 200)
        set.add(n);
}
function extractAdrs(body) {
    const set = new Set();
    for (const m of body.matchAll(/ADR[-\s]?0*(\d+)/g))
        addAdrIfValid(set, m[1]);
    for (const m of body.matchAll(/\b(00[0-9]{2})\b/g))
        addAdrIfValid(set, m[1]);
    // ADR ranges like "0011~0027" -> expand
    for (const m of body.matchAll(/(\d{4})\s*[~-]\s*(\d{4})/g)) {
        const a = Number.parseInt(m[1] ?? "", 10);
        const b = Number.parseInt(m[2] ?? "", 10);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a && b - a < 30) {
            for (let i = a; i <= b; i++)
                set.add(i);
        }
    }
    return [...set].sort((a, b) => a - b);
}
/** Extract evidence patterns from the small-cell body. */
function extractEvidence(body) {
    return {
        code: extractCodePaths(body),
        adrs: extractAdrs(body),
        tests: extractTestPaths(body),
    };
}
/** Extract QUANTA_* env-var knobs. */
function extractKnobs(body) {
    const set = new Set();
    const re = /QUANTA_[A-Z][A-Z0-9_]*/g;
    for (const m of body.matchAll(re))
        set.add(m[0]);
    return [...set].sort();
}
/** Strip evidence/knob noise from body for purpose/notes extraction. */
function stripNoise(body) {
    return body
        .replace(/`([^`]+)`/g, "$1") // unwrap inline code
        .replace(/\*\*([^*]+)\*\*/g, "$1") // unwrap bold
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // unwrap MD links
        .replace(/src\/[A-Za-z0-9_\-./]+\.(?:ts|tsx|mjs|js)(?::\d+(?:-\d+)?)?/g, "")
        .replace(/tests\/[A-Za-z0-9_\-./]+\.test\.ts/g, "")
        .replace(/ADR[-\s]?\d+/g, "")
        .replace(/QUANTA_[A-Z][A-Z0-9_]*(?:=\S+)?/g, "")
        .replace(/⚙️/g, "")
        .replace(/\([^)]{0,80}\)/g, (s) => (s.length < 12 ? s : "")) // drop long parentheticals
        .replace(/\s+/g, " ")
        .trim();
}
/** Pick first 1-2 sentences as purpose; rest -> notes. Sentence enders: . / 。 */
function splitPurposeNotes(text) {
    if (!text)
        return { purpose: "", notes: "" };
    // Split on sentence-ender boundaries but keep them.
    const enders = /([.。!?])\s+/g;
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(enders)) {
        if (m.index === undefined)
            continue;
        parts.push(text.slice(last, m.index + 1));
        last = m.index + (m[0]?.length ?? 0);
    }
    if (last < text.length)
        parts.push(text.slice(last));
    const purpose = parts.slice(0, 2).join(" ").trim().slice(0, 400);
    const rest = parts.slice(2).join(" ").trim();
    const notes = rest.slice(0, 200) + (rest.length > 200 ? "…" : "");
    return { purpose, notes };
}
/** Detect deliberate-hold markers. */
function detectHold(body) {
    return HOLD_KEYWORDS.some((kw) => body.includes(kw));
}
function detectRefined(body) {
    return /\(20\d{2}-\d{2}-\d{2}\s+refined?\)|refined\)|refine\b/i.test(body);
}
// ---------- ID generation ----------
function toKebab(s) {
    return (s
        .toLowerCase()
        .replace(/[`*_]/g, "")
        .replace(/[^\w\s가-힣-]/g, " ")
        // Strip Hangul (id is ASCII kebab) by leaving only word/space/-
        .replace(/[가-힣]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60));
}
/** Build a candidate id from title (preferred) or first English keyword. */
function deriveId(title, body) {
    let cand = toKebab(title);
    if (cand.length >= 3)
        return cand;
    // Fallback: first src/<segment> or first English word in body
    const srcMatch = body.match(/src\/([A-Za-z][A-Za-z0-9_\-./]+)\.(?:ts|tsx)/);
    if (srcMatch?.[1]) {
        cand = toKebab(srcMatch[1].replace(/\//g, "-"));
        if (cand.length >= 3)
            return cand;
    }
    const wordMatch = body.match(/[A-Za-z][A-Za-z0-9_-]{3,}/);
    if (wordMatch?.[0]) {
        cand = toKebab(wordMatch[0]);
        if (cand.length >= 3)
            return cand;
    }
    // Last resort
    return "feature";
}
/** De-dup id within a global Map by appending -2, -3, ... */
function uniquifyId(rawId, used, fallbackPrefix) {
    let id = rawId;
    if (!id || id === "feature") {
        id = fallbackPrefix ?? "feature";
    }
    if (!used.has(id)) {
        used.add(id);
        return id;
    }
    // Try fallbackPrefix-id combo first if provided
    if (fallbackPrefix && !used.has(`${fallbackPrefix}-${id}`)) {
        const combo = `${fallbackPrefix}-${id}`;
        used.add(combo);
        return combo;
    }
    let n = 2;
    while (used.has(`${id}-${n}`))
        n++;
    const final = `${id}-${n}`;
    used.add(final);
    return final;
}
// ---------- YAML serialization (inline; replace with shared yaml.ts when available) ----------
/** Stable key-order serializer for a Feature record.
 *  Delegates to the canonical mini-YAML stringifier in `./yaml.ts` (round-trip
 *  guaranteed with the canonical parser). Key order is preserved by the
 *  ordered object literal below. */
function stringifyFeature(f) {
    // Key order: id, title, section, subsystem, order, maturity, status,
    // purpose, evidence, knobs, deliberate_hold, notes.
    const ordered = {
        id: f.id,
        title: f.title,
        section: f.section,
        subsystem: f.subsystem,
        order: f.order,
        maturity: f.maturity,
        status: f.status,
        purpose: f.purpose,
        evidence: f.evidence,
        knobs: f.knobs,
        deliberate_hold: f.deliberate_hold,
        notes: f.notes,
    };
    return stringifyYaml(ordered);
}
// ---------- Build features ----------
function buildDeliberateHold(cell) {
    const matched = HOLD_KEYWORDS.map((kw) => cell.indexOf(kw)).find((i) => i >= 0);
    if (matched === undefined || matched < 0) {
        return { reason: "TODO: extract from MD migration" };
    }
    const start = Math.max(0, matched - 60);
    const end = Math.min(cell.length, matched + 200);
    const reason = stripNoise(cell.slice(start, end)).slice(0, 240);
    return { reason: reason || "TODO: extract from MD migration" };
}
function rowToFeature(row, sectionNum, subsystem, order, usedIds) {
    const title = extractTitle(row.cellSmall);
    const maturity = extractMaturity(row.cellGrade);
    const evidence = extractEvidence(row.cellSmall);
    const knobs = extractKnobs(row.cellSmall);
    const cleaned = stripNoise(row.cellSmall);
    const { purpose, notes } = splitPurposeNotes(cleaned);
    const isHold = detectHold(row.cellSmall);
    const isRefined = detectRefined(row.cellSmall);
    const status = isHold ? "hold" : isRefined ? "refined" : "stable";
    const deliberateHold = isHold ? buildDeliberateHold(row.cellSmall) : null;
    const rawId = deriveId(title, row.cellSmall);
    const subsystemHint = toKebab(subsystem).slice(0, 12) || undefined;
    const id = uniquifyId(rawId, usedIds, subsystemHint);
    return {
        id,
        title: title || id,
        section: sectionNum,
        subsystem: subsystem || "(uncategorized)",
        order,
        maturity,
        status,
        purpose: purpose || "TODO: review from migration",
        evidence,
        knobs,
        deliberate_hold: deliberateHold,
        notes: notes || "",
    };
}
function buildFeatures(md) {
    const sections = splitSections(md);
    const features = [];
    const usedIds = new Set();
    for (const [sectionNum, { body }] of [...sections.entries()].sort((a, b) => a[0] - b[0])) {
        const rows = parseTable(body);
        let inheritedSubsystem = "";
        let orderInSubsystem = 0;
        let lastSubsystemForOrder = "";
        for (const row of rows) {
            const subsystem = row.cellMid ? extractSubsystem(row.cellMid) : inheritedSubsystem;
            if (row.cellMid)
                inheritedSubsystem = subsystem;
            if (subsystem !== lastSubsystemForOrder) {
                orderInSubsystem = 0;
                lastSubsystemForOrder = subsystem;
            }
            orderInSubsystem++;
            features.push(rowToFeature(row, sectionNum, subsystem, orderInSubsystem, usedIds));
        }
    }
    return features;
}
function validateFeatures(features) {
    const warnings = [];
    const idMap = new Map();
    for (const f of features) {
        const prev = idMap.get(f.id);
        if (prev !== undefined) {
            warnings.push({
                feature: f.id,
                field: "id",
                detail: `duplicate id collision (also at section ${prev})`,
            });
        }
        else {
            idMap.set(f.id, f.section);
        }
        // Code paths
        for (const p of f.evidence.code) {
            const abs = join(REPO_ROOT, p);
            if (!existsSync(abs)) {
                warnings.push({ feature: f.id, field: "evidence.code", detail: `missing: ${p}` });
            }
        }
        // Test paths
        for (const p of [
            ...f.evidence.tests.unit,
            ...f.evidence.tests.integration,
            ...f.evidence.tests.contract,
        ]) {
            const abs = join(REPO_ROOT, p);
            if (!existsSync(abs)) {
                warnings.push({ feature: f.id, field: "evidence.tests", detail: `missing: ${p}` });
            }
        }
        // ADRs
        for (const n of f.evidence.adrs) {
            const padded = String(n).padStart(4, "0");
            const adrDir = join(REPO_ROOT, "docs", "decisions");
            // Look for any file matching 0NNN-*.md
            let found = false;
            try {
                const files = require("node:fs").readdirSync(adrDir);
                found = files.some((file) => file.startsWith(`${padded}-`));
            }
            catch {
                // ignore
            }
            if (!found) {
                warnings.push({
                    feature: f.id,
                    field: "evidence.adrs",
                    detail: `ADR-${padded} not found in docs/decisions/`,
                });
            }
        }
    }
    return warnings;
}
// ---------- Output ----------
function writeFeature(f) {
    const sectionSlug = SECTION_SLUGS[f.section] ?? `${String(f.section).padStart(2, "0")}-unknown`;
    const sectionDir = join(OUT_DIR, sectionSlug);
    mkdirSync(sectionDir, { recursive: true });
    const fileName = `${String(f.order).padStart(2, "0")}-${f.id}.yaml`;
    const filePath = join(sectionDir, fileName);
    const yaml = stringifyFeature(f);
    writeFileSync(filePath, yaml, "utf-8");
    return filePath;
}
function reportStats(features) {
    const bySection = new Map();
    const byStatus = new Map();
    const byMaturity = new Map();
    for (const f of features) {
        bySection.set(f.section, (bySection.get(f.section) ?? 0) + 1);
        byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1);
        byMaturity.set(f.maturity, (byMaturity.get(f.maturity) ?? 0) + 1);
    }
    process.stdout.write(`Total features: ${features.length}\n`);
    process.stdout.write("By section:\n");
    for (const [sec, n] of [...bySection.entries()].sort((a, b) => a[0] - b[0])) {
        process.stdout.write(`  ${sec}: ${n}\n`);
    }
    process.stdout.write("By status:\n");
    for (const [st, n] of byStatus.entries()) {
        process.stdout.write(`  ${st}: ${n}\n`);
    }
    process.stdout.write("By maturity:\n");
    for (const [m, n] of [...byMaturity.entries()].sort()) {
        process.stdout.write(`  ${m}: ${n}\n`);
    }
}
function reportWarnings(warnings) {
    if (warnings.length === 0) {
        process.stderr.write("\nSelf-validation: 0 warnings.\n");
        return;
    }
    const byField = new Map();
    for (const w of warnings) {
        byField.set(w.field, (byField.get(w.field) ?? 0) + 1);
    }
    process.stderr.write(`\nSelf-validation: ${warnings.length} warning(s)\n`);
    process.stderr.write("Breakdown by field:\n");
    for (const [field, n] of byField.entries()) {
        process.stderr.write(`  ${field}: ${n}\n`);
    }
    process.stderr.write("\nFirst 30 warnings:\n");
    process.stderr.write(`${"feature".padEnd(34)} ${"field".padEnd(22)} detail\n`);
    process.stderr.write(`${"-".repeat(34)} ${"-".repeat(22)} ${"-".repeat(40)}\n`);
    for (const w of warnings.slice(0, 30)) {
        process.stderr.write(`${w.feature.padEnd(34).slice(0, 34)} ${w.field.padEnd(22).slice(0, 22)} ${w.detail}\n`);
    }
    if (warnings.length > 30) {
        process.stderr.write(`  ... ${warnings.length - 30} more\n`);
    }
}
// ---------- Main ----------
function main() {
    const md = readSourceMd();
    const features = buildFeatures(md);
    reportStats(features);
    if (dryRun) {
        process.stdout.write("\n(--dry: no files written)\n");
    }
    else {
        let written = 0;
        for (const f of features) {
            writeFeature(f);
            written++;
        }
        // Ensure OUT_DIR section dirs exist
        process.stdout.write(`\nWrote ${written} YAML file(s) under ${OUT_DIR}\n`);
    }
    const warnings = validateFeatures(features);
    reportWarnings(warnings);
}
// Silence the require() in validate (Bun supports it but biome warns)
// Top-level entry. Don't await — script is synchronous.
main();
// Ensure dirname() is referenced so linter doesn't complain.
void dirname;
