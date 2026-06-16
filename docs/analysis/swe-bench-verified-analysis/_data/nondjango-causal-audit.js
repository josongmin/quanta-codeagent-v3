export const meta = {
  name: 'swebench-nondjango-causal-audit',
  description: 'Adversarial causal-audit + auto-fix of hard-tier non-django analysis docs',
  phases: [{ title: 'Audit' }, { title: 'Fix' }],
}
const BASE = '/Users/songmin/quanta-codeagent-v3/docs/analysis/swe-bench-verified-analysis'
const MAP = {"sympy__sympy-12489": "sympy", "sympy__sympy-22456": "sympy", "sympy__sympy-19783": "sympy", "sympy__sympy-18698": "sympy", "sympy__sympy-13974": "sympy", "sympy__sympy-20428": "sympy", "sympy__sympy-13091": "sympy", "sympy__sympy-16597": "sympy", "sympy__sympy-20438": "sympy", "sympy__sympy-15599": "sympy", "sympy__sympy-18199": "sympy", "sympy__sympy-13878": "sympy", "sympy__sympy-22080": "sympy", "sympy__sympy-21596": "sympy", "sympy__sympy-14248": "sympy", "sympy__sympy-17630": "sympy", "sympy__sympy-13615": "sympy", "sympy__sympy-13852": "sympy", "sympy__sympy-13877": "sympy", "sphinx-doc__sphinx-9461": "sphinx", "sphinx-doc__sphinx-8638": "sphinx", "sphinx-doc__sphinx-9602": "sphinx", "sphinx-doc__sphinx-7590": "sphinx", "sphinx-doc__sphinx-8551": "sphinx", "sphinx-doc__sphinx-10614": "sphinx", "sphinx-doc__sphinx-8593": "sphinx", "sphinx-doc__sphinx-10673": "sphinx", "sphinx-doc__sphinx-7748": "sphinx", "sphinx-doc__sphinx-8035": "sphinx", "sphinx-doc__sphinx-8120": "sphinx", "sphinx-doc__sphinx-9229": "sphinx", "sphinx-doc__sphinx-11510": "sphinx", "sphinx-doc__sphinx-8548": "sphinx", "matplotlib__matplotlib-25775": "matplotlib", "matplotlib__matplotlib-14623": "matplotlib", "matplotlib__matplotlib-20826": "matplotlib", "matplotlib__matplotlib-26208": "matplotlib", "matplotlib__matplotlib-25479": "matplotlib", "matplotlib__matplotlib-24870": "matplotlib", "matplotlib__matplotlib-24177": "matplotlib", "matplotlib__matplotlib-23299": "matplotlib", "matplotlib__matplotlib-25960": "matplotlib", "scikit-learn__scikit-learn-12682": "scikit-learn", "scikit-learn__scikit-learn-25102": "scikit-learn", "astropy__astropy-13977": "astropy", "astropy__astropy-14182": "astropy", "astropy__astropy-13579": "astropy", "astropy__astropy-14369": "astropy", "astropy__astropy-13398": "astropy", "astropy__astropy-14598": "astropy", "pydata__xarray-7229": "xarray", "pydata__xarray-6992": "xarray", "pydata__xarray-3095": "xarray", "pytest-dev__pytest-5840": "pytest", "pytest-dev__pytest-5787": "pytest", "pytest-dev__pytest-7490": "pytest", "pytest-dev__pytest-6197": "pytest", "pylint-dev__pylint-6386": "pylint", "pylint-dev__pylint-4551": "pylint", "pylint-dev__pylint-8898": "pylint", "mwaskom__seaborn-3187": "seaborn", "mwaskom__seaborn-3069": "seaborn"}
const ids = ["sympy__sympy-20438","sympy__sympy-22080","sympy__sympy-22456","sphinx-doc__sphinx-9229"]

const auditPrompt = (id) => { const dir = MAP[id]; return `You are an ADVERSARIAL auditor. REFUTE the analysis doc — assume wrong until proven right. The known weak spot is CAUSAL INTERPRETATION (근본원인 / 검증 픽스증명 / 모범답안): inverted routing, backwards cause→effect, mislocated guards, missing prerequisites, hallucinated functions/branches. Structural facts (counts, file names, classification) are usually fine — focus fire on the causal "why".

Files (absolute):
- Record (gold patch + test_patch = ORACLE, source of truth): ${BASE}/_data/by-instance/${id}.json
- Analysis under audit: ${BASE}/${dir}/${id}.md
- Rubric: ${BASE}/TAXONOMY.md
- Real source if needed: ~/swe-bench-repos/${dir} (checkout record.base_commit)

Verify against the gold patch/test_patch:
1. Root-cause causality — is the described mechanism the ACTUAL one? (old vs new behavior, which code path, which guard/condition). Inverted/backwards causality is the #1 target.
2. Named symbols — does every file/function/class the md names actually appear in the gold patch or verified base source? Flag hallucinations and MISLOCATIONS (right symbol, wrong owner).
3. 검증 / 픽스증명 — is the stated reason a test is FAIL_TO_PASS correct? (real behavioral fix vs infra/collection/arity reason).
4. 모범답안 — does the proposed fix match what the gold patch actually does? Is "why it generalizes / not overfit" sound? Any missing prerequisite that is the real linchpin?

Only report corrections you can back with the patch/source. Don't nitpick style. If the causal account is accurate, say SOLID.
Return structured: verdict (SOLID/MINOR-ISSUES/SERIOUS-ISSUES) + per-issue correction {section, wrong_claim, correct_fact, evidence}.` }

const AUDIT_SCHEMA = { type:'object', additionalProperties:false, required:['id','verdict','corrections'], properties:{ id:{type:'string'}, verdict:{type:'string',enum:['SOLID','MINOR-ISSUES','SERIOUS-ISSUES']}, corrections:{type:'array',items:{type:'object',additionalProperties:false,required:['section','wrong_claim','correct_fact','evidence'],properties:{section:{type:'string'},wrong_claim:{type:'string'},correct_fact:{type:'string'},evidence:{type:'string'}}}} } }

const fixPrompt = (id, audit) => { const dir = MAP[id]; return `An adversarial audit flagged CAUSAL errors in an analysis doc. Apply the corrections — but FIRST verify each against the gold patch yourself; REJECT any audit correction not actually supported by the patch/source (the auditor can be wrong too).

Files (absolute):
- Record (gold patch + test_patch = ORACLE): ${BASE}/_data/by-instance/${id}.json
- File to fix: ${BASE}/${dir}/${id}.md
- Real source if needed: ~/swe-bench-repos/${dir}

Audit verdict: ${audit.verdict}
Corrections to evaluate and apply (JSON):
${JSON.stringify(audit.corrections, null, 2)}

For each correction: confirm against the actual gold patch. If supported, rewrite the wrong sentence(s) in the named section to state correct causality/symbol/reason. If NOT supported, reject and leave the text. Change ONLY wrong parts — keep frontmatter, classification, counts, correct sections, and structure/headings intact.
Return structured: id, applied (true if changed), changes (one-line), rejected (list of unsupported corrections).` }

const FIX_SCHEMA = { type:'object', additionalProperties:false, required:['id','applied','changes'], properties:{ id:{type:'string'}, applied:{type:'boolean'}, changes:{type:'string'}, rejected:{type:'array',items:{type:'string'}} } }

const CHUNK = 2
const out = []
for (let i = 0; i < ids.length; i += CHUNK) {
  const chunk = ids.slice(i, i + CHUNK)
  const part = await parallel(chunk.map((id) => async () => {
    const audit = await agent(auditPrompt(id), { schema: AUDIT_SCHEMA, phase: 'Audit', label: `audit:${id}` })
    if (!audit) return { id, verdict: 'ERROR', fixed: false }
    if (audit.verdict === 'SOLID' || audit.corrections.length === 0) return { id, verdict: audit.verdict, fixed: false }
    const fix = await agent(fixPrompt(id, audit), { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${id}` })
    return { id, verdict: audit.verdict, fixed: !!(fix && fix.applied), rejected: (fix && fix.rejected) || [], changes: fix && fix.changes }
  }))
  out.push(...part)
  log(`chunk ${i/CHUNK+1}/${Math.ceil(ids.length/CHUNK)}: ${out.length} done, ${out.filter(r=>r&&r.verdict==='SOLID').length} solid, ${out.filter(r=>r&&r.fixed).length} fixed`)
}
const errored = out.filter((r) => !r || r.verdict === 'ERROR').map((r) => r && r.id)
return { total: ids.length, solid: out.filter(r=>r&&r.verdict==='SOLID').length, fixed: out.filter(r=>r&&r.fixed).length, errored, fixes: out.filter(r=>r&&r.fixed).map(r=>({id:r.id,verdict:r.verdict,changes:r.changes,rejected:r.rejected})) }
