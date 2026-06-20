export const meta = {
  name: 'jun16-17-adversarial-audit',
  description: 'Parallel adversarial audit of 6/16-6/17 changed files: jank, god-code, efficiency, silent-failure, correctness',
  phases: [
    { title: 'Audit' },
    { title: 'Verify' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'category', 'title', 'evidence', 'why'],
        properties: {
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'string', description: 'line number or range' },
          severity: { type: 'string', enum: ['high', 'med', 'low'] },
          category: { type: 'string', enum: ['silent-failure', 'correctness', 'god-code', 'jank', 'efficiency', 'dead-code', 'duplication'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'corrected_severity', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['real', 'overstated', 'false-positive'] },
    corrected_severity: { type: 'string', enum: ['high', 'med', 'low', 'none'] },
    reasoning: { type: 'string' },
  },
}

const AUDIT_RULES = [
  'You are an adversarial senior staff engineer reviewing recently-changed code. Read every file in your cluster with the Read tool (and grep/trace callers where needed).',
  'Hunt for, in priority order:',
  '1. SILENT FAILURE: swallowed errors, empty catch, fail-open where fail-closed is needed, default/fallback values masking bugs, discarded results, nullish-coalescing hiding upstream failure, telemetry that never fires, gates that no-op.',
  '2. CORRECTNESS: logic bugs, off-by-one, wrong condition, race, stale state, unsafe cast, broken invariants, partial writes.',
  '3. GOD-CODE: functions/files doing too much, 100+ line functions, deep nesting, mixed concerns.',
  '4. JANK: copy-paste, magic numbers/strings, misleading names, dead params, comment-lies, brittle string parsing, hand-rolled what a lib does.',
  '5. EFFICIENCY: O(n^2) on hot path, repeated work in loops, sync IO blocking, re-parsing, unbounded growth.',
  '6. DEAD-CODE / DUPLICATION: built-not-wired, unreachable branches, two copies that will drift (apps-driver vs runner-driver split-brain risk).',
  'Rules: Only report findings you can PROVE with exact code; cite file:line and paste the snippet in evidence. Be concrete about consequence in why. A default-OFF knob inert by design is NOT a finding unless wiring is broken so it can never engage. Prefer fewer high-quality findings; do not pad. Severity high=silent data loss/wrong result shipped/security, med=real bug under specific conditions or serious rot, low=cleanup.',
].join('\n')

const CLUSTERS = [
  {
    key: 'closure-core',
    label: 'closure engine core',
    files: 'src/agent/closure/bundle.ts, src/agent/closure/evaluate-success-predicate.ts, src/agent/closure/index.ts, src/agent/closure/primary-rail-step.ts, src/agent/closure/types.ts, src/agent/gate-decision.ts, src/agent/primary-rail/index.ts, src/agent/owner-admission/index.ts, src/agent/no-patch-breaker.ts, src/agent/repair-escalation.ts',
    focus: 'Proof-driven closure SSOT. Check: fail-open predicate evaluator (does fail-open hide real failures?), gate decision logic, primary-rail false-green killer (does it kill false greens or just emit telemetry?). Verify the SSOT claim: is evidence-owner-plan-gate assembled ONCE or duplicated.',
  },
  {
    key: 'evidence-plan',
    label: 'fault-evidence + verification-plan',
    files: 'src/agent/fault-evidence/build.ts, src/agent/fault-evidence/index.ts, src/agent/fault-evidence/types.ts, src/agent/verification-plan/build.ts, src/agent/verification-plan/extract-issue-declared-expected.ts, src/agent/verification-plan/index.ts, src/agent/verification-plan/types.ts',
    focus: 'extract-issue-declared-expected.ts parses fenced code blocks from issue text; brittle string parsing likely. Check whether malformed input is swallowed silently and whether expected-output recall is correct.',
  },
  {
    key: 'repair-drivers',
    label: 'repair orchestrator + eval drivers',
    files: 'src/runner/batch/eval/repair/index.ts, src/runner/batch/eval/repair/types.ts, src/runner/batch/eval/repair/validator.ts, src/runner/batch/eval/driver.ts, src/runner/batch/eval/closure-diagnostics.ts, src/runner/batch/eval/closure-diagnostics-io.ts, src/runner/batch/eval/fault-evidence.ts, src/runner/batch/eval/patch-hygiene.ts, src/runner/batch/eval/stream-tap.ts, src/apps/bench/eval/driver.ts',
    focus: 'CRITICAL: src/runner/batch/eval/driver.ts and src/apps/bench/eval/driver.ts must emit IDENTICAL telemetry (split-brain prevention). Compare them; any drift is a finding. Check validator observe-only contract, gate insertion in repair orchestrator, knob-gated emission for silent no-ops.',
  },
  {
    key: 'verify-bundle-wip',
    label: 'verification-bundle + verify-signal (WIP uncommitted)',
    files: 'src/agent/verification-bundle/index.ts, src/agent/verification-bundle/resolved-kofn.ts, src/agent/verification-bundle/score.ts, src/agent/verification-bundle/types.ts, src/agent/verify-signal.ts, src/runner/batch/eval/selection-executor.ts, src/runner/batch/eval/selection-generation-error.ts, src/runner/batch/eval/verdict.ts, src/runner/batch/eval/retry-policy.ts, src/runner/batch/types.ts',
    focus: 'UNCOMMITTED WIP, least reviewed, highest risk. resolved-kofn.ts is K-of-N resolved gating (off-by-one / threshold bugs likely). selection-generation-error.ts rule (error/refusal=generation failure, max_turns empty=no-patch candidate): verify the classification is correct and not swallowing real failures as no-patch. Check verdict.ts grading for false-neg risk.',
  },
  {
    key: 'remote-bench',
    label: 'remote bench / EC2 / full-remote / pool (incl WIP)',
    files: 'src/apps/bench/remote/ec2.ts, src/apps/bench/remote/full.ts, src/apps/bench/remote/ssh.ts, src/apps/bench/remote/pool.ts, src/apps/bench/remote/token-budget.ts, src/apps/bench/remote/box-session.ts, src/apps/bench/auth-pool/index.ts, src/apps/bench/auth-pool/load.ts',
    focus: 'box-session.ts is a 600+ line WIP refactor (detach+poll ssh); prime god-code + silent-failure territory. Check SSH command construction (shell injection / HOME quoting is a known recurring bug), spot/IMDSv2/TTL, box-death requeue, token forwarding (refresh_token must NOT leak), pool lifecycle for leaked boxes. ssh.ts grading report parse brittleness.',
  },
  {
    key: 'lsp-prewarm',
    label: 'LSP / pyright / prewarm / mention',
    files: 'src/lsp/adapters/base.ts, src/lsp/adapters/pyright.ts, src/agent/lsp-bridge.ts, src/agent/lsp-workspace-pool.ts, src/agent/loop/session-bootstrap.ts, src/agent/loop/session-lifecycle.ts, src/agent/loop/stream-consume.ts, src/agent/mention-injection/anchor-synth.ts, src/agent/mention-injection/index.ts, src/tool/lsp_nav/index.ts, src/host/runtime/internal/mention-symbol-deps.ts',
    focus: 'pyright.ts pythonPath/extraPaths config + didChangeConfiguration push (hang fix). Warm pool: leaked LSP processes, races between prewarm and first-call join, eviction correctness. session-bootstrap prewarm: does failure fail-open silently and degrade, masking a broken LSP?',
  },
  {
    key: 'knobs-config',
    label: 'knobs + config + presets',
    files: 'src/runner/knobs/knobs/bench-in-loop-exec.ts, src/runner/knobs/knobs/fault-evidence.ts, src/runner/knobs/knobs/index.ts, src/runner/knobs/knobs/lsp-steer.ts, src/runner/knobs/knobs/no-patch-breaker.ts, src/runner/knobs/knobs/patch-hygiene.ts, src/runner/knobs/knobs/primary-rail.ts, src/runner/knobs/knobs/repair-escalation.ts, src/runner/knobs/knobs/spec-fidelity-steer.ts, src/runner/knobs/knobs/verification-plan.ts, src/runner/knobs/presets.ts, src/config/knob-inventory.ts, src/runner/batch/eval/knobs-bench.ts, src/agent/localize-phase-guard.ts',
    focus: 'knob-inventory.ts claims truthful readSites for 8 NOOP-bench knobs; verify readSites match where the knob is actually read (wrong readSite = silent drift). Each knob file: is the env var actually read and routed to a real effect, or built-not-wired? localize-phase-guard: does the mutating-tool block actually block, or is it bypassable?',
  },
  {
    key: 'leaderboard-cli',
    label: 'leaderboard / analyze / bench CLI',
    files: 'src/apps/bench/analyze/leaderboard.ts, src/apps/bench/analyze/cost.ts, src/apps/bench/analyze/verdicts.ts, src/apps/bench/index.ts, src/apps/bench/cli.ts, src/runner/batch/corpus/failure-classifier.ts, src/runner/batch/corpus/paths.ts, src/runner/batch/core.ts',
    focus: 'leaderboard.ts had a /tmp report rotation regressed SSOT bug; check the union recorder for lost waves, overwrites, race on shared file, dedup correctness. failure-classifier.ts string-matching is brittle; check fallthrough/default classification swallowing unknowns. cost.ts arithmetic.',
  },
  {
    key: 'infra-perm',
    label: 'observability / permission / sandbox / fork / home',
    files: 'src/observability/index.ts, src/observability/metrics/in-memory-registry.ts, src/observability/metrics/instrument-tool.ts, src/observability/otel-span-export.ts, src/permission/index.ts, src/permission/permission-store.ts, src/permission/policy.ts, src/runtime/os-sandbox/seatbelt.ts, src/agent/fork-session-wire/default-checkpoint-base.ts, src/agent/fork-session-wire/index.ts, src/shared/quanta-home.ts, src/tool/critical-section.ts, src/tool/read/ipynb.ts',
    focus: 'permission/* and seatbelt.ts are SECURITY surfaces; any loosened gate, fail-open permission, or sandbox escape is HIGH. in-memory-registry unbounded growth (metric cardinality leak). otel-span-export: dropped spans on error? fork-session-wire comment-lie supposedly fixed; verify. ipynb.ts parsing robustness.',
  },
]

phase('Audit')
log('Auditing ' + CLUSTERS.length + ' clusters in parallel, then adversarially verifying each finding')

const results = await pipeline(
  CLUSTERS,
  (c) => agent(
    AUDIT_RULES + '\n\nYOUR CLUSTER: ' + c.label + '\nFILES: ' + c.files + '\n\nCLUSTER-SPECIFIC FOCUS: ' + c.focus + '\n\nRead every file. Return findings as structured output.',
    { label: 'audit:' + c.key, phase: 'Audit', schema: FINDINGS_SCHEMA }
  ).then((r) => ({ cluster: c.key, findings: (r && r.findings) || [] })),
  (audited) => {
    const fs = audited.findings
    if (!fs.length) return { cluster: audited.cluster, verified: [] }
    return parallel(fs.map((f) => () =>
      agent(
        'You are a skeptical verifier. Another auditor reported this finding. Re-read the actual code at ' + f.file + ':' + f.line + ' and decide if it is REAL.\n\n' +
        'FINDING [' + f.category + '/' + f.severity + ']: ' + f.title + '\nEVIDENCE: ' + f.evidence + '\nCLAIMED CONSEQUENCE: ' + f.why + '\n\n' +
        'Open the file, read the relevant code AND its callers/context. Default to skepticism: if the bug is correct-by-design, intentional fail-open, a default-OFF knob, or the consequence is overstated, say so. Only confirm real if the exact code proves the exact claimed consequence. Set corrected_severity (none for false-positive).',
        { label: 'verify:' + (f.file.split('/').pop()), phase: 'Verify', schema: VERDICT_SCHEMA }
      ).then((v) => ({ cluster: audited.cluster, finding: f, verdict: v }))
    )).then((verified) => ({ cluster: audited.cluster, verified }))
  }
)

const all = results.flat().filter(Boolean).flatMap((r) => Array.isArray(r.verified) ? r.verified : []).filter(Boolean)
const confirmed = all.filter((x) => x.verdict && x.verdict.verdict !== 'false-positive')
const order = { high: 0, med: 1, low: 2, none: 3 }
confirmed.sort((a, b) => (order[a.verdict.corrected_severity] == null ? 9 : order[a.verdict.corrected_severity]) - (order[b.verdict.corrected_severity] == null ? 9 : order[b.verdict.corrected_severity]))

return {
  total_raw_findings: all.length,
  confirmed_count: confirmed.length,
  dropped_false_positives: all.length - confirmed.length,
  findings: confirmed.map((x) => ({
    severity: x.verdict.corrected_severity,
    original_severity: x.finding.severity,
    category: x.finding.category,
    file: x.finding.file,
    line: x.finding.line,
    title: x.finding.title,
    why: x.finding.why,
    evidence: x.finding.evidence,
    verdict: x.verdict.verdict,
    verifier_note: x.verdict.reasoning,
    cluster: x.cluster,
  })),
}
