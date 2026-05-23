/**
 * Static grep-based mapper from `UseCaseId` to source/test/runbook evidence.
 *
 * Pure static analysis — no LLM, no agent run. We scan the configured roots
 * for tokens registered against each leaf (`AuditRule.tokens`) and any extra
 * required path globs. A leaf with ≥1 token hit AND ≥1 test hit is `ok`;
 * token hit but no test is `partial`; no hit at all is `tbd`; explicit
 * exclusion is `no` (scope out).
 *
 * The rule table is intentionally hand-curated and SMALL. Adding a leaf
 * without a rule degrades gracefully to `tbd` — the audit then surfaces the
 * gap and the operator either fills it in or decides `no`.
 *
 * Tool selection: ripgrep when available, BSD/GNU `grep -r -F` as fallback —
 * we use `-F` (the portable short flag for fixed-strings, supported by both
 * BSD and GNU grep) rather than `--fixed-strings` (GNU-only). Absence of BOTH
 * is treated as a HARD ERROR (`auditOne` returns coverage `tbd` with a clear
 * note instead of pretending grep succeeded and producing all-empty hits).
 */
import { spawnSync } from "node:child_process";
/** Default config — points at this repo's layout. */
export const DEFAULT_CONFIG = {
    codeRoots: ["src"],
    testRoots: ["tests"],
    runbookRoots: ["docs/runbooks"],
    rules: {},
};
/** Build the argv for ripgrep: null-separated, files-only, fixed-strings. */
const rgArgv = (token, roots) => [
    "-l",
    "--null",
    "--fixed-strings",
    "--",
    token,
    ...roots,
];
/** Build the argv for grep: portable BSD/GNU flags (`-r -l -F -Z`).
 *  `-Z` is the null-terminator (supported on both BSD and GNU); `-F` is the
 *  short fixed-strings flag. Using null-termination avoids a real-but-rare
 *  bug where a filename contains an embedded `\n` and we'd otherwise split
 *  it into two phantom paths. */
const grepArgv = (token, roots) => [
    "-r",
    "-l",
    "-F",
    "-Z",
    "--",
    token,
    ...roots,
];
/** Hard timeout for the version probe (ms). A hung `rg`/`grep` (macOS
 *  Gatekeeper prompt on first run, …) would otherwise freeze the whole eval. */
const PROBE_TIMEOUT_MS = 3_000;
/** Probe rg → grep. NULL means neither is usable (callers MUST handle this
 *  explicitly — no silent fallback to "no matches"). */
const resolveTool = (configured) => {
    if (configured !== undefined) {
        const isRg = configured === "rg" || configured.endsWith("/rg");
        return { bin: configured, argv: isRg ? rgArgv : grepArgv };
    }
    const rgProbe = spawnSync("rg", ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    if (rgProbe.status === 0)
        return { bin: "rg", argv: rgArgv };
    const grepProbe = spawnSync("grep", ["--version"], {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
    });
    if (grepProbe.status === 0)
        return { bin: "grep", argv: grepArgv };
    return null;
};
const runGrep = (tool, token, roots) => {
    const r = spawnSync(tool.bin, [...tool.argv(token, roots)], { encoding: "utf8" });
    // Both rg and grep return 1 when no match — that is NOT an error.
    const ok = r.status === 0 || r.status === 1;
    if (!ok) {
        return { files: [], status: r.status ?? -1, stderr: (r.stderr ?? "").slice(0, 200) };
    }
    // Null-separated output (`--null` / `-Z`): a filename can legally contain
    // `\n` on POSIX, so we MUST split on `\0` to avoid phantom paths.
    const files = Array.from(new Set((r.stdout ?? "").split("\0").filter((l) => l !== ""))).sort();
    return { files, status: r.status ?? 0, stderr: "" };
};
/** Score one usecase against the configured roots. */
export const auditOne = (id, cfg) => {
    const rule = cfg.rules[id];
    if (rule === undefined) {
        return { usecase: id, coverage: "tbd", evidence: [], note: "no rule registered" };
    }
    if (rule.scopedOut === true) {
        return {
            usecase: id,
            coverage: "no",
            evidence: [],
            ...(rule.note !== undefined ? { note: rule.note } : { note: "scoped out" }),
        };
    }
    const tool = resolveTool(cfg.rgBin);
    if (tool === null) {
        return {
            usecase: id,
            coverage: "tbd",
            evidence: [],
            note: "audit: neither rg nor grep available on PATH — install one to score this rule",
        };
    }
    const codeHits = new Set();
    const testHits = new Set();
    const runbookHits = new Set();
    const errors = [];
    for (const t of rule.tokens) {
        const code = runGrep(tool, t, cfg.codeRoots);
        const test = runGrep(tool, t, cfg.testRoots);
        const run = runGrep(tool, t, cfg.runbookRoots);
        for (const f of code.files)
            codeHits.add(f);
        for (const f of test.files)
            testHits.add(f);
        for (const f of run.files)
            runbookHits.add(f);
        for (const inv of [code, test, run]) {
            if (inv.status !== 0 && inv.status !== 1) {
                errors.push(`token=${t} status=${inv.status} ${inv.stderr}`.trim());
            }
        }
    }
    // A grep error must NEVER be silently treated as "no hits": producing
    // `coverage:"tbd"` from real grep failures would let infra rot into the
    // audit baseline.
    if (errors.length > 0) {
        return {
            usecase: id,
            coverage: "tbd",
            evidence: [],
            note: `audit: grep errored — ${errors.slice(0, 2).join("; ")}`,
        };
    }
    const evidence = [...codeHits, ...testHits, ...runbookHits].sort();
    const hasCode = codeHits.size > 0;
    const hasTest = testHits.size > 0;
    const coverage = hasCode && hasTest ? "ok" : hasCode ? "partial" : "tbd";
    return {
        usecase: id,
        coverage,
        evidence,
        ...(rule.note !== undefined ? { note: rule.note } : {}),
    };
};
