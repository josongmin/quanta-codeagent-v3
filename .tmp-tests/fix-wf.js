export const meta = {
  name: 'bugbash-fix-all',
  description: 'Fix all 31 actionable bug-bash findings (SOTA++): disjoint-file parallel impl + adversarial verify',
  phases: [{ title: 'Implement' }, { title: 'Verify' }],
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['group', 'fixes', 'test_files', 'risks', 'needs_design'],
  properties: {
    group: { type: 'string' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'file', 'what', 'gated_behind_knob', 'test_name', 'test_proves'],
        properties: {
          id: { type: 'number' },
          file: { type: 'string' },
          what: { type: 'string', description: 'concise description of the actual change made' },
          gated_behind_knob: { type: 'string', description: 'knob name if behavioral change is gated, else "none (pure bugfix)" or "n/a (comment/cleanup)"' },
          test_name: { type: 'string', description: 'the test() title that proves this fix, or "none" if pure comment/cleanup' },
          test_proves: { type: 'string', description: 'how the test fails WITHOUT the fix (red-on-injection)' },
        },
      },
    },
    test_files: { type: 'array', items: { type: 'string' } },
    risks: { type: 'string' },
    needs_design: { type: 'boolean', description: 'true if any finding could not be safely fixed and was left documented-only' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['group', 'verdict', 'per_finding', 'summary'],
  properties: {
    group: { type: 'string' },
    verdict: { type: 'string', enum: ['solid', 'minor-issues', 'broken'] },
    per_finding: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'fix_correct', 'test_has_teeth', 'scope_clean', 'note'],
        properties: {
          id: { type: 'number' },
          fix_correct: { type: 'boolean' },
          test_has_teeth: { type: 'boolean', description: 'does the test actually fail without the change (not vacuous)?' },
          scope_clean: { type: 'boolean', description: 'no unrelated churn / no repo-wide lint damage' },
          note: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const COMMON = [
  'You are a SOTA++ staff engineer fixing audited findings in a SWE-bench eval harness. Read the FULL detail of YOUR finding ids in docs/bugbash/jun-20-bugbash.findings.json (fields why/evidence/verifier_note) before touching code.',
  'HARD RULES:',
  '- Match the surrounding code style EXACTLY (imports via @/, bun:test, biome formatting, naming, comment density).',
  '- MEASUREMENT INTEGRITY: if a fix would change default benchmark behavior/outcomes, gate it behind the EXISTING default-OFF knob for that feature so default behavior stays byte-identical. Pure bug fixes (swallowed errors, wrong results, undercounts, unreachable/dead code, comment-lies) fix directly — no knob.',
  '- If a finding CANNOT be safely fixed without risky design (e.g. would alter eval outcomes with no existing knob), DO NOT guess: leave a precise clarifying code comment, set that fix gated_behind_knob="n/a (documented-only)", and set needs_design=true. Better honest than reckless.',
  '- Every behavioral fix needs a test with TEETH: it must FAIL if your change is reverted (red-on-injection). Put new tests in the named test file for your group (create it). Use real observable effects, not mocks asserting themselves.',
  '- ONLY edit the files assigned to your group. NEVER run repo-wide lint:fix / biome --write on the repo; if you must format, only `node_modules/.bin/biome check --write <your-files>`.',
  '- Verify your own test passes: `bun test <your-test-file>`. Do NOT run full typecheck (cache races) — the orchestrator runs it.',
  '- "none"-severity findings (#32, #33) are by-design non-bugs: only add a clarifying comment, no behavior change.',
].join('\n')

const GROUPS = [
  {
    key: 'repair-gate',
    files: 'src/agent/primary-rail/index.ts, src/runner/batch/eval/repair/index.ts, src/runner/batch/eval/repair-phase-policy.ts, src/runner/batch/eval/closure-session.ts',
    test: 'tests/unit/bugbash-fix-repair-gate.test.ts',
    ids: '#1, #8, #32',
    directive: [
      '#1 (MED, the keystone): decidePrimaryRailFinishGate exists but has ZERO callers. WIRE it into the repair loop (src/runner/batch/eval/repair/index.ts) so a non-primary / false-green validation does NOT count as finished — GATED behind the existing primary-rail knob (default-OFF ⇒ byte-identical). Reuse decidePrimaryRailFinishGate; do not re-implement. When knob ON and isFalseGreen(vi) (predicate evaluable && matched===false), the round must NOT clear as validated (block/continue per the gate). Test: knob ON + a false-green validation result ⇒ not treated as validated; knob OFF ⇒ identical to today.',
      '#8 (LOW): closure-session pins gate.stakes (crossFile/destructive/patchFileCount) false. Verifier says stakes are genuinely pre-patch-unknowable (by-design) while uncertainty IS derived live. Do NOT fabricate stakes. Add a precise comment explaining WHY stakes are neutral pre-patch, and if the `structure` LSP gate-source is truly unreachable given pinned inputs, remove that dead branch or comment it. Minimal, no behavior change to the live uncertainty path.',
      '#32 (none): decideRepairAdmission "already green" guard is unreachable at this call site by design — add a one-line clarifying comment only.',
    ].join('\n'),
  },
  {
    key: 'drivers',
    files: 'src/apps/bench/eval/driver.ts, src/runner/batch/eval/driver.ts',
    test: 'tests/unit/bugbash-fix-drivers.test.ts',
    ids: '#6, #9, #27, #33',
    directive: [
      '#6 (MED, split-brain): runner driver emits knobs_applied via emitKnobsApplied (un-exported) at both agent entry points; production apps driver re-implements runAgentOnce/runAgentPhase with their own BenchStreamTap but NEVER emits it. FIX: export emitKnobsApplied from the runner driver and CALL it in the apps driver at both BenchStreamTap construction sites (runAgentOnce + runAgentPhase). This is a pure observability bugfix (no knob). Test: apps-driver path emits a knobs_applied stream event.',
      '#9 (LOW): decideEscalation result is computed post-repair and only stored as telemetry; never widens the search. If a repairEscalation knob exists and is default-OFF, WIRE the escalation to actually act when ON (byte-identical default). If wiring would need design, document + needs_design. Test (if wired): knob ON ⇒ escalation observable.',
      '#27 (LOW): apps driver has tentative-patch retention the runner driver lacks (split-brain). Prefer PARITY: if porting tentative to the runner driver is small/safe, do it; else add an explicit comment documenting the intentional divergence and why. ',
      '#33 (none): apps runInstance budget telemetry reports adaptedTimeoutMs==base because it deliberately does not adapt — add a clarifying comment only.',
    ].join('\n'),
  },
  {
    key: 'permission-race',
    files: 'src/permission/permission-store.ts',
    test: 'tests/unit/bugbash-fix-permission-race.test.ts',
    ids: '#2',
    directive:
      '#2 (MED, correctness): mergeWithDisk snapshots `inMemory` BEFORE `await rereadForMerge()`; a synchronous setThread/recordDenial/recordUserOverride during the await window mutates live state, then the merge callback overwrites it from the stale snapshot — losing a grant or a freshly-recorded denial (security state). FIX: capture the merge input at callback-invocation time (re-snapshot inside the callback) instead of before the await, so interleaved mutations survive the merge. Test with TEETH: simulate a mutation interleaving during the flush IO window and assert it is NOT lost.',
  },
  {
    key: 'cost',
    files: 'src/apps/bench/analyze/cost.ts',
    test: 'tests/unit/bugbash-fix-cost.test.ts',
    ids: '#3',
    directive:
      '#3 (MED, undercount): fromObserve uses readdirSync(...).find(...) which returns ONE arbitrary attempt file (`<id>.0.jsonl`) for Best-of-N, so an n=4 run reports ~1/4 of tokens/cost when the report.json-usage fallback fires. FIX: aggregate ALL matching attempt files (`<id>.*.jsonl`) and sum tokens across them. Test: a 3-attempt observe dir sums all three, not one.',
  },
  {
    key: 'lsp',
    files: 'src/agent/lsp-bridge.ts',
    test: 'tests/unit/bugbash-fix-lsp.test.ts',
    ids: '#4, #20, #21',
    directive: [
      '#4 (MED, silent-failure): isAvailable caches the probe PROMISE forever and never invalidates a cached `false`; one transient `bin --version` failure (5s race under load, PATH not ready) permanently disables ALL LSP surfaces process-wide. FIX: cache only SUCCESSES (or apply a TTL / reset-on-false), mirroring the `once` memoizer that resets on reject. Test: a first probe that returns false must NOT poison a later successful probe.',
      '#20 (LOW): hand-rolled `uri.replace(/^file:\\/\\//,"")` mishandles URL-encoded paths. Replace with node fileURLToPath at both sites (l.uri and firstUri). Test: a file:// uri with an encoded char (e.g. %20) resolves to the decoded path.',
      '#21 (LOW): import-probe line cap (PYRIGHT_IMPORT_SCAN_LINE_CAP=200) silently marks a file verified-ready when imports live past line 200. Fix so a file whose relevant imports are beyond the cap is not falsely marked ready (raise/remove cap or scan smarter). Keep it cheap. Test if observable.',
    ].join('\n'),
  },
  {
    key: 'ec2-sg',
    files: 'src/apps/bench/remote/ec2.ts',
    test: 'tests/unit/bugbash-fix-ec2-sg.test.ts',
    ids: '#5',
    directive:
      '#5 (MED, silent-failure): ensureSecurityGroup folds a describe FAILURE (found.code !== 0 = network/creds error) into the same branch as "SG not found", then tries create-security-group, masking the real cause. The sibling box-session.ts ensureSecurityGroup already does it right: throw a dedicated "could not reach EC2 (network/credentials?)" on describe failure BEFORE the empty/None check. PORT that exact behavior into ec2.ts. Test: a describe failure (nonzero exit) throws a connectivity error, not a create attempt.',
  },
  {
    key: 'selection',
    files: 'src/runner/batch/eval/selection-executor.ts',
    test: 'tests/unit/bugbash-fix-selection.test.ts',
    ids: '#7',
    directive:
      '#7 (MED, efficiency): with earlyAccept on, scoreOne (regression/resolvedKofN ⇒ tree reset + pytest/repro) runs during generation for the early-gate check, its ScoredEntry is discarded, then finalize calls scoreOne AGAIN for the same candidate — up to 2N expensive pytest materializations instead of N. FIX: MEMOIZE the scoreOne result per candidate (cache by candidate identity) so finalize reuses the first-pass verdict instead of recomputing. Must not change selection outcomes — only avoid recompute. Test with TEETH: a counting/spy port proves scoreOne runs ONCE per candidate, and selection result is unchanged.',
  },
  {
    key: 'extractor',
    files: 'src/agent/verification-plan/extract-issue-declared-expected.ts',
    test: 'tests/unit/bugbash-fix-extractor.test.ts',
    ids: '#10, #11',
    directive: [
      '#10 (LOW, silent-failure): the EXPECT_RE pre-gate is strictly narrower than EXPECT_LITERAL_RE, so valid declared outputs that EXPECT_LITERAL_RE would match are silently dropped because EXPECT_RE.test() gates them out first. FIX so the pre-gate does not exclude inputs the real matcher accepts (widen or remove the redundant pre-gate). Test: an input EXPECT_LITERAL_RE matches but old EXPECT_RE rejected now extracts.',
      '#11 (LOW, jank): the comment claims the EXPECT_RE pre-check is a harmless intent-marker, but it actively suppresses matches. After fixing #10, correct the comment to describe real behavior (no comment-lie).',
    ].join('\n'),
  },
  {
    key: 'metrics',
    files: 'src/observability/metrics/in-memory-registry.ts',
    test: 'tests/unit/bugbash-fix-metrics.test.ts',
    ids: '#12, #13',
    directive: [
      '#13 (LOW, silent-failure): sink send/flush failures are swallowed in bare try/catch with no signal. Add a rate-limited internal error counter / dropped-sample counter so silent sink failure is observable. Test: a throwing sink increments the counter.',
      '#12 (LOW, efficiency): snapshot() allocates O(series) every call and the series Map has no per-metric series cap (cardinality leak). Add a bounded per-metric series cap (drop/又 count overflow) to prevent unbounded growth. Keep snapshot correct. Test: exceeding the cap is bounded + counted, not unbounded.',
    ].join('\n'),
  },
  {
    key: 'knobs-cfg',
    files: 'src/runner/batch/eval/knobs-bench.ts, src/config/knob-inventory.ts',
    test: 'tests/unit/bugbash-fix-knobs-cfg.test.ts',
    ids: '#14, #16',
    directive: [
      '#14 (LOW, dead-code): the `sotaOn` posture field is computed but has zero production consumers. Either remove it cleanly (and any now-dead computation) OR wire its only legitimate consumer. Prefer removal if truly unused. Update/!break the SOTA hellgate test if it asserts the field (coordinate: that test is owned by the score+test group — only touch knobs-bench.ts here; if removal breaks that test, set needs_design and note it).',
      '#16 (LOW, jank): the readSite for the 8 NOOP-bench closure knobs points at the NOOP knob-declaration file, not the real effect site (driver.ts), so `/knobs` mis-routes an operator. FIX the readSite strings to point at the actual effect site. Test: knob-inventory readSite for these knobs resolves to a file that actually reads the knob.',
    ].join('\n'),
  },
  {
    key: 'bench-cli',
    files: 'src/apps/bench/index.ts, src/apps/bench/cli.ts',
    test: 'tests/unit/bugbash-fix-bench-cli.test.ts',
    ids: '#17, #18, #19',
    directive: [
      '#17 (LOW, efficiency): the dataset JSONL is parsed 3× per run (and again for dry-run). Parse once and reuse. No behavior change. Test if observable (parse count / single read).',
      '#18 (LOW, correctness): --max-workers accepts negative/zero and ships it verbatim to remote --max_workers. Validate: reject/clamp to >=1 with a clear error. Test: --max-workers 0 / -1 is rejected or clamped.',
      '#19 (LOW, correctness): --skip-resolved casts resolved_ids to string[] without filtering non-strings. Filter to strings. Test: a resolved_ids array with a non-string entry does not crash / is filtered.',
    ].join('\n'),
  },
  {
    key: 'box-session',
    files: 'src/apps/bench/remote/box-session.ts',
    test: 'tests/unit/bugbash-fix-box-session.test.ts',
    ids: '#23, #24, #26',
    directive: [
      '#23 (LOW, correctness/security): runId flows unquoted into remote ssh commands with no boundary sanitization (shell-injection defense-in-depth gap). Add validation/quoting so runId cannot break out of the remote command (e.g. assert runId matches a safe charset at the boundary, or shell-quote it). Test: a runId with a shell metachar is rejected/escaped, not interpolated raw.',
      '#24 (LOW, correctness): stripToAccessToken only guards access_token and silently drops account fields whose absence may make the shipped token unusable. Verify the whitelist keeps all fields the box actually needs; if a needed field is being dropped, keep it (still NEVER ship refresh_token). Test: required non-secret account fields survive, refresh_token never does.',
      '#26 (LOW, god-code): box-session.ts mixes lifecycle + snapshot telemetry + remote python probe + verdict parsing + command construction in 600+ lines. Do a SAFE, behavior-preserving extraction of ONE cohesive concern (e.g. the remote verdict/probe parsing) into a sibling module with its own unit test. Do NOT do a risky wholesale rewrite. If extraction is too risky mid-file, set needs_design and document the seam instead.',
    ].join('\n'),
  },
  {
    key: 'remote-misc',
    files: 'src/apps/bench/auth-pool/load.ts',
    test: 'tests/unit/bugbash-fix-remote-misc.test.ts',
    ids: '#25',
    directive: [
      'NOTE: #22 (pool.ts) is DEFERRED — pool.ts is currently being edited live by the user; do NOT touch it.',
      '#25 (LOW, silent-failure): defaultAuthFile falls back to filesystem root when HOME is unset (`${env.HOME ?? ""}/.quanta/...`). FIX: fail loudly or use a real home resolver (os.homedir) when HOME is unset, never silently build a root path. Test: HOME unset ⇒ throws or resolves to a real home, not "/.quanta/...".',
    ].join('\n'),
  },
  {
    key: 'grading',
    files: 'src/runner/batch/eval/closure-diagnostics-io.ts, src/runner/batch/eval/verdict.ts, src/agent/verify-signal.ts',
    test: 'tests/unit/bugbash-fix-grading.test.ts',
    ids: '#28, #29, #30',
    directive: [
      '#29 (LOW, correctness): PASS_SUMMARY_RE = /\\b\\d+\\s+passed\\b/i matches "0 passed", so a zero-test / all-skipped run with non-zero exit + no failure marker grades PASS. FIX: require a POSITIVE passed count ([1-9]\\d* passed), matching the house pattern in verify-signal OUTCOME_FAILURE_MATCHERS. Test: "0 passed" no longer grades green; "5 passed" still does.',
      '#30 (LOW, correctness): a generic error/failure-count matcher in verify-signal OUTCOME_FAILURE_MATCHERS can flip a real PASS to fail-closed on incidental output. Tighten the matcher so incidental "error" text in passing output does not force a fail. Test: passing output containing an incidental "error" word is not failed; a real "N failed" still fails.',
      '#28 (LOW, correctness): endReasonOf ignores InstanceResult.stopReason, so no_patch_exhausted_rate is ~always 0 for single-attempt runs. FIX endReasonOf to consider stopReason. Test: a result with stopReason set yields the correct endReason/no_patch_exhausted classification.',
    ].join('\n'),
  },
  {
    key: 'score-test',
    files: 'src/agent/verification-bundle/score.ts, tests/unit/bench-sota-preset-hellgate.test.ts',
    test: 'tests/unit/bugbash-fix-score.test.ts',
    ids: '#31, #15',
    directive: [
      '#31 (LOW, jank): voterQuorum soft signal silently clamps votes/k > 1 to 1, conflating super-quorum with exact quorum. FIX so super-quorum is distinguishable (do not lose the >1 signal), or document precisely why clamping is intended. Test: votes/k of exactly-quorum vs super-quorum produce distinguishable signals.',
      '#15 (LOW, jank): bench-sota-preset-hellgate.test.ts comments describe a `sotaOn ||` / `sotaOn ? :` composition that no longer exists in benchPostureFromState — the red-on-injection claims are stale (lost teeth). UPDATE the comments to match the real current composition, and ensure each test still has real teeth (fails if the real branch is removed). Note: the knobs-cfg group may remove the sotaOn field (#14) — if so, reconcile these tests accordingly.',
    ].join('\n'),
  },
]

phase('Implement')
log('Implementing ' + GROUPS.length + ' disjoint-file groups in parallel (31 actionable findings)')

const impls = await parallel(GROUPS.map((g) => () =>
  agent(
    COMMON + '\n\n===== YOUR GROUP: ' + g.key + ' =====\n' +
    'ASSIGNED FILES (edit ONLY these + your test file): ' + g.files + '\n' +
    'NEW TEST FILE: ' + g.test + '\n' +
    'FINDINGS: ' + g.ids + '\n\nFIX DIRECTIVES:\n' + g.directive +
    '\n\nImplement all, write teeth tests in the test file, run `bun test ' + g.test + '`, then return the structured report.',
    { label: 'impl:' + g.key, phase: 'Implement', schema: IMPL_SCHEMA }
  ).then((r) => ({ group: g.key, files: g.files, test: g.test, report: r }))
))

phase('Verify')
const verifs = await parallel(impls.filter(Boolean).map((im) => () =>
  agent(
    'You are a skeptical reviewer. Adversarially verify the fixes in group "' + im.group + '".\n' +
    'Run `git diff -- ' + im.files.split(', ').join(' ') + '` AND read the new test file ' + im.test + ' and run it with `bun test ' + im.test + '`.\n' +
    'For EACH finding id the implementer claims to have fixed, judge: (a) fix_correct — does the diff actually fix the audited problem and match surrounding style? (b) test_has_teeth — REVERT the change mentally (or check) and confirm the test would FAIL without it; a test that passes regardless is vacuous=false. (c) scope_clean — no unrelated churn, no repo-wide lint damage, only assigned files touched.\n' +
    'Implementer self-report (may be wrong — do not trust, verify against the real diff):\n' + JSON.stringify(im.report) +
    '\n\nReturn the structured verdict.',
    { label: 'verify:' + im.group, phase: 'Verify', schema: VERDICT_SCHEMA }
  ).then((v) => ({ group: im.group, verdict: v }))
))

const reports = impls.filter(Boolean).map((i) => ({ group: i.group, report: i.report }))
const verdicts = verifs.filter(Boolean).map((v) => ({ group: v.group, verdict: v.verdict }))
return { groups: GROUPS.length, reports, verdicts }
