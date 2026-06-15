export const meta = {
  name: 'swebench-django-taxonomy-retry',
  description: 'Re-analyze remaining django SWE-bench problems to the formalized TAXONOMY.md rubric',
  phases: [{ title: 'Classify', detail: 'one agent per remaining django instance' }],
}

const BASE = '/Users/songmin/quanta-codeagent-v3/docs/analysis/swe-bench-verified-analysis'
const ids = ["django__django-13807", "django__django-13809", "django__django-13810", "django__django-13820", "django__django-13821", "django__django-13837", "django__django-13925", "django__django-13933", "django__django-13964", "django__django-14017", "django__django-14034", "django__django-14053", "django__django-14089", "django__django-14122", "django__django-14140", "django__django-14155", "django__django-14170", "django__django-14238", "django__django-14311", "django__django-14315", "django__django-14349", "django__django-14351", "django__django-14373", "django__django-14376", "django__django-14404", "django__django-14434", "django__django-14493", "django__django-14534", "django__django-14580", "django__django-14608", "django__django-14672", "django__django-14725", "django__django-14765", "django__django-14915", "django__django-14999", "django__django-15022", "django__django-15037", "django__django-15098", "django__django-15103", "django__django-15104", "django__django-15127", "django__django-15128", "django__django-15161", "django__django-15252", "django__django-15268", "django__django-15277", "django__django-15278", "django__django-15280", "django__django-15315", "django__django-15368", "django__django-15375", "django__django-15380", "django__django-15382", "django__django-15467", "django__django-15499", "django__django-15503", "django__django-15525", "django__django-15554", "django__django-15561", "django__django-15563", "django__django-15569", "django__django-15572", "django__django-15629", "django__django-15695", "django__django-15731", "django__django-15732", "django__django-15741", "django__django-15814", "django__django-15851", "django__django-15863", "django__django-15916", "django__django-15957", "django__django-15973", "django__django-15987", "django__django-16032", "django__django-16082", "django__django-16100", "django__django-16116", "django__django-16493", "django__django-16502", "django__django-16527", "django__django-16560", "django__django-16569", "django__django-16595", "django__django-16612", "django__django-16631", "django__django-16642", "django__django-16661", "django__django-16662", "django__django-16667", "django__django-16801", "django__django-16819", "django__django-16877", "django__django-16899", "django__django-16901", "django__django-16938", "django__django-16950", "django__django-17029", "django__django-17084", "django__django-17087", "django__django-7530", "django__django-9296"]

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
const results = await pipeline(
  ids,
  (id) => agent(promptFor(id) + `\n\nAfter writing, return the structured result.`, {
    label: id, phase: 'Classify', schema: SCHEMA,
  }),
)
const ok = results.filter((r) => r && r.written).length
const failed = ids.filter((id, i) => !results[i] || !results[i].written)
log(`taxonomy retry: ${ok}/${ids.length}; failed=${failed.length}`)
return { written: ok, total: ids.length, failed, classifications: results.filter(Boolean).map((r) => ({ id: r.id, type: r.primary_type, tier: r.tier })) }
