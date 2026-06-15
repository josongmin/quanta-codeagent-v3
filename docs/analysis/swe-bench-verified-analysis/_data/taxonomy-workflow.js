export const meta = {
  name: 'swebench-django-taxonomy-retry',
  description: 'Re-analyze remaining django SWE-bench problems to the formalized TAXONOMY.md rubric',
  phases: [{ title: 'Classify', detail: 'one agent per remaining django instance' }],
}

const BASE = '/Users/songmin/quanta-codeagent-v3/docs/analysis/swe-bench-verified-analysis'
const ids = ["django__django-16661", "django__django-16667", "django__django-16801", "django__django-16819", "django__django-16877", "django__django-16899", "django__django-16901", "django__django-16938", "django__django-16950", "django__django-17029", "django__django-17084", "django__django-17087", "django__django-7530", "django__django-9296"]

const promptFor = (id) => `You are upgrading the analysis doc for ONE SWE-bench Verified django problem to a formalized taxonomy.

READ these three files (absolute paths):
1. Rubric (SSOT — follow exactly): ${BASE}/TAXONOMY.md
2. Instance record (JSON; gold patch + tests = oracle): ${BASE}/_data/by-instance/${id}.json
3. Existing analysis (keep the good content): ${BASE}/django/${id}.md

Then REWRITE the md file (same path, #3) to the enriched format from TAXONOMY.md "각 문제 md 출력 포맷".

Frontmatter — keep instance_id/repo/base_commit/version/difficulty/created_at/fail_to_pass/pass_to_pass/gold_files AND add: primary_type, tier, loc_axis, repair_strategy, knowledge, flags.
Use the controlled vocabulary EXACTLY: primary_type ∈ T-LocTrivial/T-DirectMap/T-ConstraintReason/T-SpecInference/T-GenValidate/T-DomainBound/T-DesignRefactor/T-DiffuseLoc; tier ∈ T1..T6; loc_axis ∈ L0..L3; repair_strategy ∈ S1..S6 (optional +secondary); knowledge ∈ K-Gen/K-Domain/K-API; flags ⊆ overfit-risk/regression-trap/underspecified/has-repro/cross-file-dep.

Body sections (Korean), in this order:
- ## 문제 요약
- ## 유형 (정형화) — 3축(L/S/K) 각 점수+한줄근거 + primary type 한줄근거. 왜 이 repair strategy인지 APR 관점으로 구체적으로.
- ## 난이도 티어 — 티어 + 어떤 구조적 피처(파일수/줄수/localize직접성/repro/도메인/P2P trap)가 이 티어로 미는지. 공식 difficulty 라벨과 다르면 왜 다른지 명시.
- ## 골드패치 분석 — 건드린 파일·함수 / 근본원인 / 수정요지
- ## 검증 (test_patch) — FAIL_TO_PASS 동작 / 픽스 증명 / overfit·regression 관점
- ## 모범답안 (오라클 기반) — 이상적 풀이 궤적 4단계: (1)localize 경로 (2)픽스와 왜 올바른 일반화인지 (3)regression 안전 (4)함정 회피

Rules: be rigorous and concrete, name REAL symbols from the gold patch, classification must be defensible against the rubric. Frontmatter fail_to_pass/pass_to_pass MUST be the EXACT length of those JSON arrays. Write ONLY that one md file. Then return the structured result.`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'written', 'primary_type', 'tier'],
  properties: {
    id: { type: 'string' }, written: { type: 'boolean' },
    primary_type: { type: 'string' }, tier: { type: 'string' },
    loc_axis: { type: 'string' }, knowledge: { type: 'string' },
  },
}

phase('Classify')
// Low concurrency: 4 at a time, sequential chunks, to stay under server-side rate limit.
const CHUNK = 4
const results = []
for (let i = 0; i < ids.length; i += CHUNK) {
  const chunk = ids.slice(i, i + CHUNK)
  const part = await parallel(
    chunk.map((id) => () => agent(promptFor(id) + `\n\nAfter writing, return the structured result.`, {
      label: id, phase: 'Classify', schema: SCHEMA,
    })),
  )
  results.push(...part)
  log(`chunk ${i / CHUNK + 1}/${Math.ceil(ids.length / CHUNK)} done (${results.filter((r) => r && r.written).length} ok)`)
}
const ok = results.filter((r) => r && r.written).length
const failed = ids.filter((id, i) => !results[i] || !results[i].written)
log(`taxonomy retry: ${ok}/${ids.length}; failed=${failed.length}`)
return { written: ok, total: ids.length, failed, classifications: results.filter(Boolean).map((r) => ({ id: r.id, type: r.primary_type, tier: r.tier })) }
