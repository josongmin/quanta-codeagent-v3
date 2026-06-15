export const meta = {
  name: 'swebench-django-causal-audit',
  description: 'Adversarial causal-audit + auto-fix of hard-tier django analysis docs (T5 + reasoning-heavy T4)',
  phases: [{ title: 'Audit' }, { title: 'Fix' }],
}

const BASE = '/Users/songmin/quanta-codeagent-v3/docs/analysis/swe-bench-verified-analysis'
const ids = ["django__django-16661", "django__django-16938", "django__django-16950", "django__django-17084", "django__django-11734"]

const auditPrompt = (id) => `You are an ADVERSARIAL auditor. REFUTE the analysis doc — assume wrong until proven right. The known weak spot is CAUSAL INTERPRETATION (근본원인 / 검증 픽스증명 / 모범답안): inverted routing, backwards cause→effect, mislocated guards, missing prerequisites. Structural facts (counts, file names, classification) are usually fine — focus fire on the causal "why".

Files (absolute):
- Record (gold patch + test_patch = ORACLE, source of truth): ${BASE}/_data/by-instance/${id}.json
- Analysis under audit: ${BASE}/django/${id}.md
- Rubric: ${BASE}/TAXONOMY.md
- Real source if needed: ~/swe-bench-repos/django (checkout record.base_commit)

Verify against the gold \`patch\`/\`test_patch\`:
1. Root-cause causality — is the described mechanism the ACTUAL one? (old behavior vs new behavior, which code path, which guard/condition). Inverted or backwards causality is the #1 target.
2. Named symbols — does every file/function/class/condition the md names actually appear in the gold patch or verified base source? Flag hallucinations and MISLOCATIONS (right symbol, wrong owner/function).
3. 검증 / 픽스증명 — is the stated reason a test is FAIL_TO_PASS correct? (real behavioral fix vs infra/collection/arity reason).
4. 모범답안 — does the proposed fix match what the gold patch actually does? Is "why it generalizes / not overfit" sound? Any missing prerequisite (e.g. a capability enabled by the base commit) that is the real linchpin?

Only report corrections you can back with the patch/source. Do NOT nitpick style. If the causal account is accurate, say SOLID.

Return structured: verdict (SOLID / MINOR-ISSUES / SERIOUS-ISSUES), and for each issue a correction {section, wrong_claim, correct_fact, evidence (patch line / symbol)}.`

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'verdict', 'corrections'],
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['SOLID', 'MINOR-ISSUES', 'SERIOUS-ISSUES'] },
    corrections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['section', 'wrong_claim', 'correct_fact', 'evidence'],
        properties: {
          section: { type: 'string' },
          wrong_claim: { type: 'string' },
          correct_fact: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

const fixPrompt = (id, audit) => `An adversarial audit flagged CAUSAL errors in an analysis doc. Apply the corrections — but FIRST verify each one against the gold patch yourself; REJECT any audit correction that is not actually supported by the patch/source (the auditor can be wrong too).

Files (absolute):
- Record (gold patch + test_patch = ORACLE): ${BASE}/_data/by-instance/${id}.json
- File to fix: ${BASE}/django/${id}.md
- Real source if needed: ~/swe-bench-repos/django

Audit verdict: ${audit.verdict}
Corrections to evaluate and apply (JSON):
${JSON.stringify(audit.corrections, null, 2)}

For each correction: confirm it against the actual gold \`patch\` field. If supported, rewrite the wrong sentence(s) in the named section to state the correct causality/symbol/reason. If NOT supported by the patch, reject it and leave the text. Change ONLY the wrong parts — keep frontmatter, classification, counts, and all correct sections intact. Preserve the doc structure and section headings exactly.

Return structured: id, applied (true if you changed the file), changes (one-line summary), rejected (list of audit corrections you found unsupported, empty if none).`

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'applied', 'changes'],
  properties: {
    id: { type: 'string' },
    applied: { type: 'boolean' },
    changes: { type: 'string' },
    rejected: { type: 'array', items: { type: 'string' } },
  },
}

// Chunked: 4 concurrent at a time, each doing audit -> (maybe) fix sequentially. Rate-limit safe.
const CHUNK = 2
const out = []
for (let i = 0; i < ids.length; i += CHUNK) {
  const chunk = ids.slice(i, i + CHUNK)
  const part = await parallel(chunk.map((id) => async () => {
    const audit = await agent(auditPrompt(id), { schema: AUDIT_SCHEMA, phase: 'Audit', label: `audit:${id}` })
    if (!audit) return { id, verdict: 'ERROR', fixed: false }
    if (audit.verdict === 'SOLID' || audit.corrections.length === 0) {
      return { id, verdict: audit.verdict, fixed: false, nIssues: 0 }
    }
    const fix = await agent(fixPrompt(id, audit), { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${id}` })
    return { id, verdict: audit.verdict, fixed: !!(fix && fix.applied), nIssues: audit.corrections.length, rejected: (fix && fix.rejected) || [], changes: fix && fix.changes }
  }))
  out.push(...part)
  const solid = out.filter((r) => r && r.verdict === 'SOLID').length
  const fixed = out.filter((r) => r && r.fixed).length
  log(`chunk ${i / CHUNK + 1}/${Math.ceil(ids.length / CHUNK)}: ${out.length} done, ${solid} solid, ${fixed} fixed`)
}

const solid = out.filter((r) => r && r.verdict === 'SOLID')
const fixed = out.filter((r) => r && r.fixed)
const errored = out.filter((r) => !r || r.verdict === 'ERROR')
return {
  total: ids.length,
  solid: solid.length,
  fixed: fixed.length,
  errored: errored.map((r) => r && r.id),
  fixes: fixed.map((r) => ({ id: r.id, verdict: r.verdict, changes: r.changes, rejected: r.rejected })),
  flagged_not_fixed: out.filter((r) => r && r.verdict !== 'SOLID' && r.verdict !== 'ERROR' && !r.fixed).map((r) => r.id),
}
