/**
 * SWE-bench Verified smoke-pick selector / auditor.
 *
 * The 6 smoke picks (see PINNED below) are a FROZEN regression baseline — they
 * must not drift silently. This script does two things:
 *
 *   bun run tests/smoke/swebench/select.ts --audit
 *     Fetch the live `princeton-nlp/SWE-bench_Verified` split and assert every
 *     PINNED instance still satisfies the smoke-grade CRITERIA below, printing
 *     the metrics + a ranked list of equally-qualified alternatives. Exit 1 if
 *     any pinned instance is missing or now violates a criterion.
 *
 *   bun run tests/smoke/swebench/select.ts --write
 *     Re-extract the PINNED rows VERBATIM from the upstream dataset and rewrite
 *     `picks.jsonl` (official snake_case shape that bench's parseSwebenchJsonl
 *     ingests). Use only when intentionally re-pinning.
 *
 * Why these CRITERIA (smoke = deterministic, cheap, reliable — NOT a capability
 * sweep): a smoke target must clone+set-up fast, have an unambiguous single-file
 * fix, and a tiny verifiable test surface, so a recorded-then-replayed run is
 * stable run-to-run and a human can eyeball the gold patch in seconds.
 */
const DATASET = "princeton-nlp/SWE-bench_Verified";
const ROWS_API = "https://datasets-server.huggingface.co/rows";
/** Frozen smoke baseline. Order = picks.jsonl order. */
export const PINNED = [
    "psf__requests-5414", // requests/models.py — HTTP lib, light env
    "pallets__flask-5014", // src/flask/blueprints.py — web framework
    "pylint-dev__pylint-4970", // pylint/checkers/similar.py — linter
    "pytest-dev__pytest-7982", // src/_pytest/pathlib.py — test framework
    "sympy__sympy-16886", // sympy/crypto/crypto.py — math (very clear stmt)
    "sympy__sympy-13480", // sympy/functions/elementary/hyperbolic.py — math (other subsystem)
];
/**
 * Repos deliberately EXCLUDED from smoke: C-extension / heavy-numeric deps make
 * env setup slow and flaky (scikit-learn, matplotlib, astropy, xarray). django
 * is pure-python but slow to set up; kept out of the 6-pick light tier.
 */
const LIGHT_REPOS = new Set([
    "psf/requests",
    "pallets/flask",
    "pylint-dev/pylint",
    "pytest-dev/pytest",
    "sympy/sympy",
]);
const goldFiles = (patch) => {
    const m = patch.matchAll(/diff --git a\/(\S+) /g);
    return [...m].map((x) => x[1]);
};
const f2pCount = (row) => {
    try {
        return JSON.parse(row.FAIL_TO_PASS).length;
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
};
/** Smoke-grade gate. Returns the list of violated criteria (empty = passes). */
export const violations = (row) => {
    const v = [];
    if (row.difficulty !== "<15 min fix")
        v.push(`difficulty=${row.difficulty}`);
    const files = goldFiles(row.patch);
    if (files.length !== 1)
        v.push(`goldFiles=${files.length}`);
    const patchLines = row.patch.split("\n").length;
    if (patchLines > 22)
        v.push(`patchLines=${patchLines}`);
    const f2p = f2pCount(row);
    if (f2p > 2)
        v.push(`failToPass=${f2p}`);
    if (!LIGHT_REPOS.has(row.repo))
        v.push(`repo=${row.repo} (not light)`);
    return v;
};
const fetchAll = async () => {
    const rows = [];
    for (let offset = 0; offset < 500; offset += 100) {
        const url = `${ROWS_API}?dataset=${encodeURIComponent(DATASET)}&config=default&split=test&offset=${offset}&length=100`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`HF rows API ${res.status} at offset ${offset}`);
        const body = (await res.json());
        rows.push(...body.rows.map((r) => r.row));
    }
    return rows;
};
const main = async () => {
    const mode = process.argv.includes("--write") ? "write" : "audit";
    const all = await fetchAll();
    const byId = new Map(all.map((r) => [r.instance_id, r]));
    if (mode === "write") {
        const lines = PINNED.map((id) => {
            const r = byId.get(id);
            if (!r)
                throw new Error(`pinned instance not in dataset: ${id}`);
            return JSON.stringify(r);
        });
        await Bun.write(`${import.meta.dir}/picks.jsonl`, `${lines.join("\n")}\n`);
        console.log(`wrote picks.jsonl (${lines.length} official-format rows)`);
        return;
    }
    // audit
    let bad = 0;
    console.log(`SWE-bench Verified smoke audit — ${PINNED.length} pinned, ${all.length} dataset rows\n`);
    for (const id of PINNED) {
        const r = byId.get(id);
        if (!r) {
            console.log(`✗ ${id} — MISSING from dataset`);
            bad++;
            continue;
        }
        const v = violations(r);
        const f2p = f2pCount(r);
        const tag = v.length === 0 ? "✓" : "✗";
        console.log(`${tag} ${id.padEnd(26)} ${r.repo.padEnd(20)} patch=${r.patch.split("\n").length}L f2p=${f2p}${v.length ? `  VIOLATIONS: ${v.join(", ")}` : ""}`);
        if (v.length)
            bad++;
    }
    const alts = all
        .filter((r) => violations(r).length === 0 && !PINNED.includes(r.instance_id))
        .map((r) => r.instance_id);
    console.log(`\nEqually-qualified alternatives (same criteria, not pinned): ${alts.length}`);
    console.log(alts.slice(0, 20).join(", ") + (alts.length > 20 ? ", …" : ""));
    if (bad > 0) {
        console.error(`\nAUDIT FAILED: ${bad} pinned instance(s) missing or out of criteria.`);
        process.exit(1);
    }
    console.log("\nAUDIT OK: all pinned smoke picks satisfy criteria.");
};
// Run as a CLI only; importing (e.g. the guard test) must not fetch.
if (import.meta.main)
    await main();
