# Terminal-Bench 실패 RCA + 타입별 해결법 (quanta+gpt-5.4, 2026-07-01)

두 실런(5-task=2/5, 10-task=3/10) + verifier ctrf(어느 테스트가 왜 깨졌나) + 실제 `tests/test_outputs.py` 어써션 + `solve.sh` 정답접근을 교차한 RCA. **근시안 금지**: "oracle-loop 하나로 다 해결"은 과잉통일이었다 — 실패마다 메커니즘이 다르고, **절반은 스캐폴드로, 절반은 모델로만** 풀린다.

> ⚠️ 자기검증 주의: 앞선 "내 분석이 예측 적중" 주장은 **약한 증거**다 — "main risk"가 원래 그 task의 뻔한 실패축이라 사후 매칭이 쉬웠다. 강한 증거는 아래 verifier 실측(어느 테스트가 깨졌나)이다.

---

## 실측: 10-run 실패 7개, 깨진 테스트별

| task | 결과 | 깨진 테스트 (통과/전체) | out토큰 | gate 측정가능? |
|---|---|---|--:|---|
| llm-inference-batching-scheduler | ❌ | `test_generate_and_schema` + `test_performance_thresholds` (4/6) | 6588 | 일부(perf ✅, schema는 spec) |
| largest-eigenval | ❌ | `test_speedup` (2/3) | 3966 | ✅ (하지만 numpy/LAPACK 이겨야=빡셈) |
| winning-avg-corewars | ❌ | `test_warrior_performance` (2/3) | 3078 | ✅ (pmars win-rate 5-floor) |
| merge-diff-arc-agi-task | ❌ | `test_algo_map_function_with_test_input` (4/5) | 4058 | ❌ (hidden `/tests/test.json`) |
| break-filter-js-from-html | ❌(지난런 ✅) | `test_outputs` (0/1) | **361** | ✅ (filter.py+headless 로컬재현 가능) |
| write-compressor | ❌ | 전멸 (0/3) | 6172 | ✅ (round-trip) 하지만 24h RE |
| gpt2-codegolf | ❌ | (0/…) | — | — (40h) |

**핵심 관찰**: 4/6·2/3·4/5·2/3 = **대부분 부분통과**인데 TB reward가 binary라 0. 근데 **왜** 마지막 조각을 못 넘었는지는 task마다 다르다.

---

## 재분류: 레버가 어디 있냐로 (스캐폴드 vs 모델)

### A. 스캐폴드-addressable — gpt-5.4도 더 나은 루프면 통과

**A1. Measure-to-gate 미달** (corewars · llm-scheduler-perf · eigenval*)
- task가 **수치 gate를 명시**(win-rate≥75/33, perf threshold, speedup>ref)하고 **로컬 측정도구를 제공**(pmars·eval.py·timing harness)하는데, 에이전트가 **"correct/동작함"에서 멈추고 gate까지 튜닝 안 함.**
- 증거: corewars는 warrior가 *존재*(test_warrior_exists ✅)하지만 *성능*(win-rate floor)서 미달. eigenval은 *정확*(eigen_pair·dominance ✅)하지만 *speedup* 미달.
- `*eigenval은 경계` — 측정은 되나 baseline(numpy=LAPACK)이 빡세서 지식도 필요(B1과 겹침).

**A2. Output-contract 미스** (llm-scheduler-schema)
- `test_generate_and_schema` fail = 산출물 **스키마/포맷이 spec과 불일치**(feasibility·coverage·consistency는 통과했는데). 순수 부주의/spec-미준수.

**A3. Engagement variance / 조기-bail** (break-filter)
- **지난런 ✅(13분 긴루프) → 이번 ❌(361토큰 bail).** 능력은 있는데 **로컬 verifier(filter.py+headless)를 안 세우고 1턴에 포기.** 비결정성 = 신뢰도 문제지 능력 문제 아님.

### B. 모델-bound — Opus 4.8급 아니면 스캐폴드로 못 만듦

**B1. Hard-baseline 알고리즘** (eigenval speedup)
- numpy/LAPACK보다 빠른 small-matrix eigensolver를 **알아야** 함. iterate로 brute-force 안 됨. 측정은 되지만 지식 천장.

**B2. 귀납적 일반화** (merge-diff-arc-agi)
- hidden `/tests/test.json`이라 **측정 불가**. visible examples로 `(i+j)%3` 규칙을 추론하되 **과적합 없이 일반화**해야. 핵심은 추론력(모델).

**B3. 깊은 리버스엔지니어링/코드골프** (write-compressor 24h, gpt2-codegolf 40h)
- 전멸(0/3). 설계레벨 깊이 — 스캐폴드 레버 없음.

**집계**: 7 실패 중 **A(스캐폴드) ~3-4개**(corewars·llm-scheduler·break-filter·eigenval일부) · **B(모델) ~3-4개**(eigenval-baseline·arc-agi·write-compressor·gpt2). → **단일병목 아님.** Opus 4.8 재런이 B절반을, "gate-loop+verify-before-submit" 스캐폴드가 A절반을 연다.

---

## 타입별 해결법 (구체 + quanta 기존 knob 매핑)

### A1 → **Gate-as-objective 루프** (최고 ROI, 즉시 가능)
task instruction에 **수치 gate**가 있으면: (1) 목표값을 명시 추출, (2) task가 준 측정도구(pmars/eval.py/timing)로 **매 iteration 측정**, (3) **측정값이 margin 두고 gate 넘을 때까지** 정지 금지("correct"에서 멈추지 말 것).
- quanta 매핑: `bench-in-loop-exec=full` + `repro-test` 철학 그대로 — 터미널 container_exec exit-code 루프가 이걸 위해 존재. **갭은 에이전트가 stated-gate 대비 안 쓰는 것** → 프롬프트/steer에 "수치 gate면 매턴 측정+margin까지" 규칙.

### A2 → **Output-contract self-check**
끝내기 전 instruction의 **정확한 산출 spec**(파일경로·스키마·포맷) 재독 + 산출물 검증. 체크리스트형 self-verify 스텝.

### A3 → **Verify-before-submit + persistence** (break-filter류, 코인플립→안정)
로컬 재현 가능한 체크(filter.py·Selenium·round-trip)가 있으면 **세워서 통과 확인 전엔 finalize 금지.** 조기-bail 차단.
- quanta 매핑: SWE-bench `must-pass=sticky`(sticky-red) knob과 동형 — verified 전엔 정지 금지. TB brain에 이식하면 break-filter 같은 "능력은 되는데 가끔 포기"를 안정화.

### B1 → **모델 + (조심스런) 지식** — 스캐폴드로 못 만듦. Opus 4.8 재런. 도메인힌트 주입은 answer-key 위험이라 지양.

### B2 → **Self-generated held-out 테스트** (부분 완화)
귀납 task는: 규칙 가설 → **안 본 새 케이스 스스로 생성** → 규칙이 일반화되는지 self-test → 과적합보다 **최단 규칙(Occam) 선호.** 핵심은 모델 추론력이라 완전 해결은 아님.

### B3 → **모델 천장** — 스캐폴드 레버 없음. Opus 4.8도 실패 가능(24-40h task). 측정용으로만.

---

## 결론 (non-myopic)

1. **TB 실패는 단일병목 아님** — 6개 다른 메커니즘. "self-verify against proxy"는 A1/A3에만 맞고, B는 다른 얘기.
2. **~절반은 스캐폴드로 즉시 개선 가능**(A1 gate-loop · A2 spec-check · A3 verify-before-submit=sticky). 이게 gpt-5.4로도 오르는 부분 = **높은 ROI, quanta 기존 knob 이식**.
3. **~절반은 모델-bound**(B1 지식 · B2 추론 · B3 깊이). **Opus 4.8 재런**이 여는 부분. 스캐폴드로는 못 만듦.
4. 다음 실험: (a) TB brain에 **A1+A3 스캐폴드 이식**(gate-loop + sticky-verify) → gpt-5.4 재측정, (b) **Opus 4.8** 재런 → B 델타 측정. 두 축 분리해서 A/B.
