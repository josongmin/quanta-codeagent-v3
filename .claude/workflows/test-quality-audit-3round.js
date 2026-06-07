export const meta = {
  name: 'test-quality-audit-3round',
  description: 'Adversarial 3-round audit of the test suite for janky / tautological / pointless / mislabeled tests',
  phases: [
    { title: 'Sweep', detail: 'broad grep+sample finders across all test path clusters' },
    { title: 'Deep-Recheck', detail: 'fresh-eyes full reads of high-risk hellgate/e2e/integration files' },
    { title: 'Completeness', detail: 'critic probes for under-detected classes & under-sampled areas' },
    { title: 'Verify', detail: 'per-file adversarial verifier cross-checks production code' },
    { title: 'Synth', detail: 'dedup + prioritized report' },
  ],
}

const TAXONOMY = `ANTI-PATTERN TAXONOMY — the kinds of bad/janky/pointless tests to flag:
1. TAUTOLOGICAL — assertion cannot fail: expect(true).toBe(true) with no real SUT call before it; expect(x).toBe(x); asserting a literal you just defined; asserting a mock returns exactly what you configured it to return.
2. REIMPLEMENTED — the test defines a LOCAL copy of the production logic and tests the copy; production code is never imported/run. (HIGH value; grep cannot find these, must read.)
3. NON_EXECUTING — production module is imported but the code path under test is never actually invoked; the assertion checks a fixture/constant, not SUT output.
4. VACUOUS_GUARD — expect(()=>fn()).not.toThrow() (or similar) as the ONLY assertion for a behavior that has a checkable result. weak != always-wrong: if the SUT genuinely only has a no-throw contract and real code ran, that is fine — only flag when a real result was thrown away.
5. OVER_MOCKED — every collaborator the test touches is mocked/stubbed so it asserts the mock wiring, not real behavior ("tests the mock").
6. SKIPPED_TOMBSTONE — describe.skip/it.skip/xit/xdescribe with no runtime-conditional reason; commented-out dead test bodies left as tombstones.
7. LOC_STRUCTURE_BUDGET — asserts on source file line-counts, function counts, or greps production source for a token instead of asserting behavior (brittle proxy).
8. SNAPSHOT_JUNK — toMatchSnapshot on huge/volatile output, or a snapshot that locks in nothing meaningful.
9. FLAKY — wallclock/timing assertions (p50/p99, clock deltas, timer-ordering), unseeded randomness, real network/clock dependence.
10. NO_ASSERTION — test body with zero expect/assert (passes unless it throws). Flag unless clearly a deliberate documented "does not throw" smoke.
11. TESTING_FRAMEWORK — asserts a JS builtin / third-party lib / the test runner itself works, not your code.
12. DUPLICATE — near-identical test body redundant with another test.
13. FAKE_E2E — file named *e2e*/integration that does NOT exercise the real subject (no real subprocess/server/db/browser/file-io) but stubs it all — mislabeled, false confidence.
14. CHEATING_CIRCULAR — expected value computed by the same function under test, or the current (possibly buggy) output hardcoded as "expected".
15. TS_IGNORE_ESCAPE — @ts-nocheck/@ts-ignore/as any used to silence a real type mismatch in the SUT contract.

NUANCE: weak != wrong. A test that runs real production code then asserts a no-throw / non-null contract is acceptable, NOT a finding. Only flag tests that are pointless, misleading, mislabeled, brittle-by-proxy, or that never run the code they claim to test. IGNORE the file tests/unit/test-quality-ratchet-hellgate.test.ts (it intentionally contains expect(true) for self-test). IGNORE anything under .git/.`

const FINDING_ITEM = {
  type: 'object',
  required: ['file', 'class', 'severity', 'evidence', 'why'],
  properties: {
    file: { type: 'string', description: 'repo-relative path' },
    line: { type: 'integer' },
    testName: { type: 'string', description: 'describe/it title if known' },
    class: { type: 'string', enum: ['TAUTOLOGICAL','REIMPLEMENTED','NON_EXECUTING','VACUOUS_GUARD','OVER_MOCKED','SKIPPED_TOMBSTONE','LOC_STRUCTURE_BUDGET','SNAPSHOT_JUNK','FLAKY','NO_ASSERTION','TESTING_FRAMEWORK','DUPLICATE','FAKE_E2E','CHEATING_CIRCULAR','TS_IGNORE_ESCAPE','OTHER'] },
    severity: { type: 'string', enum: ['HIGH','MED','LOW'] },
    evidence: { type: 'string', description: 'the offending code snippet' },
    why: { type: 'string', description: 'why this is a bad/janky/pointless test; name the production symbol that SHOULD have been exercised' },
  },
}
const FINDINGS_SCHEMA = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: FINDING_ITEM } } }

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['file', 'verdicts'],
  properties: {
    file: { type: 'string' },
    productionUnderTest: { type: 'string', description: 'what production code this file claims to test, and whether it is actually invoked' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['class', 'verdict', 'severity', 'reasoning', 'recommendation'],
        properties: {
          testName: { type: 'string' },
          line: { type: 'integer' },
          class: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED_BAD','FALSE_POSITIVE','INTENTIONAL_WEAK'] },
          severity: { type: 'string', enum: ['HIGH','MED','LOW'] },
          reasoning: { type: 'string' },
          recommendation: { type: 'string', description: 'concrete fix: delete / rewrite-to-invoke-real-code / add-real-assertion / replace-LOC-guard-with-behavior / gate-flaky-behind-flag / merge-duplicate' },
        },
      },
    },
  },
}

const CLUSTERS = [
  { label: 'unit-ab', paths: 'tests/unit/[ab]*.test.ts' },
  { label: 'unit-c', paths: 'tests/unit/c*.test.ts' },
  { label: 'unit-def', paths: 'tests/unit/[def]*.test.ts' },
  { label: 'unit-ghijk', paths: 'tests/unit/[ghijk]*.test.ts' },
  { label: 'unit-lm', paths: 'tests/unit/[lm]*.test.ts' },
  { label: 'unit-no', paths: 'tests/unit/[no]*.test.ts' },
  { label: 'unit-p', paths: 'tests/unit/p*.test.ts' },
  { label: 'unit-qr', paths: 'tests/unit/[qr]*.test.ts' },
  { label: 'unit-s-a-h', paths: 'tests/unit/s[a-h]*.test.ts' },
  { label: 'unit-s-i-z', paths: 'tests/unit/s[i-z]*.test.ts' },
  { label: 'unit-tz', paths: 'tests/unit/[tuvwxyz]*.test.ts' },
  { label: 'unit-agent', paths: 'tests/unit/agent/**/*.test.ts' },
  { label: 'unit-cli', paths: 'tests/unit/cli/**/*.test.ts , tests/unit/apps/cli/**/*.test.ts , src/apps/cli/__tests__/**/*.test.ts' },
  { label: 'unit-tool-perm-runtime', paths: 'tests/unit/tool/**/*.test.ts , tests/unit/permission/**/*.test.ts , tests/unit/runtime/**/*.test.ts , tests/unit/runner/**/*.test.ts , src/permission/__tests__/**/*.test.ts' },
  { label: 'unit-mcp-llm-gh-auth', paths: 'tests/unit/mcp/**/*.test.ts , tests/unit/llm/**/*.test.ts , tests/unit/llm-providers/**/*.test.ts , tests/unit/integrations/github/**/*.test.ts , tests/unit/auth/**/*.test.ts , src/mcp/**/__tests__/**/*.test.ts , src/llm/**/__tests__/**/*.test.ts' },
  { label: 'unit-rest', paths: 'tests/unit/coordination/** , tests/unit/retrieval/** , tests/unit/memory/** , tests/unit/ipc/** , tests/unit/observability/** , tests/unit/scheduler/** , tests/unit/workflow/** , tests/unit/workflows/** , tests/unit/security/** , tests/unit/stream/** , tests/unit/skill/** , tests/unit/host/** , tests/unit/subagent/** , tests/unit/shared/** , tests/unit/session/** , tests/unit/realtime/** , tests/unit/kernel/** , tests/unit/issue-hint/** , tests/unit/repro-test/** , tests/unit/sdk/** , tests/unit/rules/** , tests/unit/patch/** , tests/unit/loop/** , tests/unit/git/** , tests/unit/apps/agent/** , tests/unit/apps/web-daemon/** , src/agent/**/__tests__/**/*.test.ts , apps/web-frontend/src/**/*.test.ts , apps/web-frontend/src/**/*.test.tsx , tests/contract/** , tests/eval/**' },
  { label: 'integ-a-l', paths: 'tests/integration/[a-l]*.test.ts , tests/integration/admissibility-wave-a/**/*.test.ts' },
  { label: 'integ-m-z', paths: 'tests/integration/[m-z]*.test.ts' },
  { label: 'structural-guards', paths: 'tests/unit/*-slice-boundary.test.ts  PLUS any test that does readFileSync on SOURCE and asserts .length/toBeLessThan, or greps production source for a token (use Grep for readFileSync + toBeLessThan + slice-boundary across tests/)' },
]

const finderPrompt = (c) => `You are auditing TEST QUALITY in a TypeScript (bun test) repo at the current working directory. Audit ONLY the test files matching these path(s)/spec: ${c.paths}

${TAXONOMY}

METHOD:
1. Use Glob to enumerate the test files in your assigned paths.
2. Grep within them for signatures: "expect(true)", ".skip(", "xit(", "not.toThrow", "vi.mock", "mock(", "toMatchSnapshot", clock/timer calls, "p50", "p99", "@ts-nocheck", "@ts-ignore", "readFileSync", "toBeLessThan(", "toBeGreaterThan(0)".
3. Read the hit excerpts AND fully read the most suspicious files (especially large *hellgate*/*e2e*/integration files) to catch REIMPLEMENTED / NON_EXECUTING / OVER_MOCKED / FAKE_E2E which grep cannot find — for those, verify whether the production module is actually imported and its code path actually invoked (vs an inline fake/stub).
4. Report every genuinely bad/janky/pointless test with concrete evidence (the offending code) and the production symbol that SHOULD have been exercised.

Precision over recall-padding: weak-but-real tests are NOT findings. Return findings via the schema; file = repo-relative path.`

const DEEP_GROUPS = [
  ['tests/unit/apps/cli/session-loop-hellgate.test.ts','tests/unit/apps/cli/session-setup-hellgate.test.ts'],
  ['tests/unit/subagent-6-tools-hellgate.test.ts','tests/unit/subagent-tool-replay-hellgate.test.ts'],
  ['tests/unit/memory-hellgate.test.ts','tests/unit/memory/auto-trigger-hellgate.test.ts'],
  ['tests/unit/mcp-deep-security-r4-hellgate.test.ts','tests/unit/mcp-cluster-hardening-r1-hellgate.test.ts','tests/unit/mcp-inbound-adversarial-hellgate.test.ts'],
  ['tests/unit/manifest-codex-compat-hellgate.test.ts','tests/unit/observability-metrics-instrument-tool-dedup-hellgate.test.ts'],
  ['tests/unit/reactor-trigger-source.test.ts','tests/unit/eval-grounding-normalizer.test.ts'],
  ['tests/unit/shadow-odb-hellgate.test.ts','tests/unit/auto-sweep-hellgate.test.ts','tests/unit/auth/chatgpt-oauth-adapter.test.ts'],
  ['tests/integration/agent-loop.test.ts','tests/integration/subagent-fork-e2e.test.ts'],
  ['tests/integration/session-chaos-and-attack.test.ts','tests/integration/session-stress-and-concurrent.test.ts'],
  ['tests/integration/resume-e2e.test.ts','tests/integration/multi-plane-e2e-hellgate.test.ts','tests/integration/browser-real-chrome-adversarial-e2e.test.ts'],
  ['tests/integration/docker-sandbox-e2e.test.ts','tests/integration/bench-python-harness-e2e.test.ts','tests/integration/bench-repair.test.ts'],
  ['tests/integration/abort-mid-recovery-hell-e2e.test.ts','tests/integration/debug-cli-surface-e2e-hellgate.test.ts','tests/integration/hard-deny-mid-multitool-hell-e2e.test.ts'],
  ['tests/integration/verify-guard-e2e.test.ts','tests/integration/verify-guard-hellgate-e2e.test.ts','tests/integration/mode-block-matrix-e2e.test.ts','tests/integration/fallback-x-verify-closeout-hell-e2e.test.ts'],
  ['tests/integration/knob-control-plane-e2e-hellgate.test.ts'],
]

const deepPrompt = (files) => `You are doing a DEEP fresh-eyes test-quality audit. FULLY READ each of these specific test files and judge whether they are honest, meaningful tests or janky/pointless/mislabeled ones. For EACH file, also open the PRODUCTION code it imports and confirm the code path under test is actually invoked (NOT re-implemented inline, NOT stubbed away). For files named *e2e*/integration, verify whether a REAL subject is exercised (real subprocess/server/db/browser/file-io) or whether it is all mocked (FAKE_E2E).

Files:
${files.map((f) => '  - ' + f).join('\n')}

${TAXONOMY}

Focus especially on REIMPLEMENTED, NON_EXECUTING, OVER_MOCKED, FAKE_E2E, CHEATING_CIRCULAR — the classes only a full read reveals. Report findings via schema with concrete evidence and the production symbol that should have run.`

// throttle concurrency to dodge server-side rate limiting (waves of WAVE)
const WAVE = 6
async function inWaves(items, thunkFactory, waveSize) {
  const out = []
  for (let i = 0; i < items.length; i += waveSize) {
    const res = await parallel(items.slice(i, i + waveSize).map(thunkFactory))
    out.push(...res)
  }
  return out
}

phase('Sweep')
const sweep = await inWaves(CLUSTERS, (c) => () =>
  agent(finderPrompt(c), { label: 'sweep:' + c.label, phase: 'Sweep', schema: FINDINGS_SCHEMA }), WAVE)
const sweepFindings = sweep.filter(Boolean).flatMap((r) => r.findings || [])
log(`Sweep: ${sweepFindings.length} candidate findings from ${CLUSTERS.length} clusters`)

phase('Deep-Recheck')
const deep = await inWaves(DEEP_GROUPS, (g) => () =>
  agent(deepPrompt(g), { label: 'deep:' + (g[0].split('/').pop().replace('.test.ts','').slice(0, 22)), phase: 'Deep-Recheck', schema: FINDINGS_SCHEMA }), WAVE)
const deepFindings = deep.filter(Boolean).flatMap((r) => r.findings || [])
log(`Deep-Recheck: ${deepFindings.length} candidate findings from ${DEEP_GROUPS.length} groups`)

const norm = (s) => (s || '').toString().trim().toLowerCase()
const keyOf = (f) => `${norm(f.file)}::${norm(f.class)}::${f.line != null ? f.line : norm(f.testName)}`
const mergedMap = new Map()
for (const f of [...sweepFindings, ...deepFindings]) {
  if (!f || !f.file) continue
  if (norm(f.file).includes('.git/')) continue
  const k = keyOf(f)
  if (!mergedMap.has(k)) mergedMap.set(k, f)
}
let candidates = [...mergedMap.values()]
log(`Merged+deduped: ${candidates.length} unique candidates`)

phase('Completeness')
const clusterList = CLUSTERS.map((c) => c.label).join(', ')
const deepList = DEEP_GROUPS.flat().join(', ')
const compactCands = candidates.map((c) => `${c.file} [${c.class}/${c.severity}] ${c.why}`).slice(0, 400).join('\n')
const completeness = await agent(`You are a COMPLETENESS CRITIC for a test-quality audit of a bun-test TypeScript repo (cwd = repo root).
Candidates found so far (${candidates.length}):
${compactCands}

Coverage so far: Round-1 swept clusters: ${clusterList}. Round-2 deep-read: ${deepList}.

${TAXONOMY}

Identify (a) anti-pattern CLASSES that look under-detected, (b) test directories/areas that were under-sampled and likely still hide bad tests, (c) any SYSTEMIC test-quality smell across the suite. Then run targeted Glob/Grep/Read probes to confirm 2-6 concrete NEW findings the audit missed (do not duplicate the candidates above). Return the new findings via schema; put coverage-gap observations in the 'why' fields.`, { label: 'completeness-critic', phase: 'Completeness', schema: FINDINGS_SCHEMA })
const extra = (completeness && completeness.findings ? completeness.findings : []).filter((f) => f && f.file && !norm(f.file).includes('.git/'))
for (const f of extra) { const k = keyOf(f); if (!mergedMap.has(k)) mergedMap.set(k, f) }
candidates = [...mergedMap.values()]
log(`After completeness critic: ${candidates.length} candidates (+${extra.length})`)

phase('Verify')
const byFile = new Map()
for (const f of candidates) { const k = f.file; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(f) }
const fileGroups = [...byFile.entries()]
log(`Verifying ${candidates.length} candidates across ${fileGroups.length} files`)

const verdicts = await inWaves(fileGroups, ([file, cands]) => () =>
  agent(`You are an ADVERSARIAL VERIFIER. A prior pass flagged the test file ${file} with these candidate findings:
${cands.map((c, i) => `${i + 1}. [${c.class}/${c.severity}] line ${c.line != null ? c.line : '?'} — ${c.why}\n   evidence: ${c.evidence}`).join('\n')}

Read the ACTUAL test file ${file} IN FULL, and read/grep the PRODUCTION code it imports. Then adjudicate EACH candidate as one of:
- CONFIRMED_BAD: it really is tautological/reimplemented/non-executing/fake/flaky/etc. as described.
- FALSE_POSITIVE: the finding is wrong — the test actually exercises real production code and asserts a meaningful contract.
- INTENTIONAL_WEAK: weak but defensible (real code runs then a no-throw/non-null contract is asserted; runtime-conditional skip; deliberate documented smoke). Not worth changing.

Default toward FALSE_POSITIVE if you cannot PROVE the test is bad. For each CONFIRMED_BAD give a concrete recommendation. You MAY add NEW findings for this same file that the prior pass missed (include them in verdicts with their own class).

${TAXONOMY}

Return via schema; productionUnderTest = the real module/symbol this file should exercise and whether it does.`,
    { label: 'verify:' + file.split('/').pop().replace('.test.ts','').slice(0, 24), phase: 'Verify', schema: VERDICT_SCHEMA }), WAVE)

const confirmed = []
for (const v of verdicts.filter(Boolean)) {
  for (const d of (v.verdicts || [])) {
    if (d.verdict === 'CONFIRMED_BAD') confirmed.push({ file: v.file, productionUnderTest: v.productionUnderTest, ...d })
  }
}
const fpCount = verdicts.filter(Boolean).flatMap((v) => v.verdicts || []).filter((d) => d.verdict === 'FALSE_POSITIVE').length
const iwCount = verdicts.filter(Boolean).flatMap((v) => v.verdicts || []).filter((d) => d.verdict === 'INTENTIONAL_WEAK').length
log(`Verify: ${confirmed.length} CONFIRMED_BAD, ${fpCount} false-positive, ${iwCount} intentional-weak`)

phase('Synth')
const confirmedCompact = confirmed.map((c) => `- ${c.file}${c.line ? ':' + c.line : ''} [${c.class}/${c.severity}] ${c.reasoning} || FIX: ${c.recommendation}`).join('\n')
const report = await agent(`Synthesize a final TEST-QUALITY AUDIT report (Korean, plain prose + grouped tables) from these CONFIRMED bad tests:
${confirmedCompact}

Group by anti-pattern CLASS, ordered by severity (HIGH first). For each finding give: file path, the problem in one line, and the concrete fix. Add a short top summary: total confirmed, count by class, and the 3 most important things to fix first. Be concrete and honest; do not pad. Output markdown.`,
  { label: 'synth-report', phase: 'Synth' })

return {
  counts: { sweep: sweepFindings.length, deep: deepFindings.length, completeness: extra.length, candidates: candidates.length, confirmed: confirmed.length, falsePositive: fpCount, intentionalWeak: iwCount, filesVerified: fileGroups.length },
  confirmed,
  report,
}
