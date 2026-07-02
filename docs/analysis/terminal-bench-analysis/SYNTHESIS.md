# Terminal-Bench — 횡단 종합 (89 task 전수 분석)

`terminal-bench` 데이터셋 89개를 **solve.sh(정답)+instruction+verifier 기반으로 전수 분석**한 cross-cutting 결론. 근거는 per-task md(`tasks/<category>/<task>.md`) 89개 + frontmatter 집계(`_data/classified.json`).

> 분석 상태: 89/89 완료(2026-07-01), 7 병렬 에이전트가 각 task의 실제 파일서 도출. 집계는 md frontmatter가 SSOT.

---

## 🔴 헤드라인: Terminal-Bench의 1/3은 "터미널 작업"이 아니라 "터미널에서 도는 코딩"이다

`terminal_native`(이 task가 얼마나 진짜 터미널 작업이냐 vs 순수 코딩) 분포:

| terminal_native | n | 의미 |
|---|--:|---|
| **low** | 30 (34%) | 사실상 코딩 문제 — 스펙대로 파일 하나 작성, 터미널은 실행판일 뿐. **SWE-스캐폴드와 스킬 겹침** |
| **med** | 35 (39%) | 코드 + 실제 env/도구 셋업(uv venv, deps, 빌드) 결합 |
| **high** | 24 (27%) | 시스템상태/멀티스텝셸/비대화형도구/장시간프로세스가 본질 — **터미널 에이전트의 진짜 시험대** |

**함의**: TB를 "코딩 벤치"로 보면 안 되지만(메모리 정설 유지), **"코딩 아님"도 과장**이다. 실측하니 **1/3(30개)이 low = 순수 코딩**이고, 그중 다수가 CODE-AUTHOR(스펙→프로그램). 즉 TB는 **코딩(low) + 코딩+환경(med) + 순수 터미널작업(high)의 3분할**이고, quanta의 SWE 스캐폴드 강점은 low/med 65개에 그대로 전이된다. **quanta 고유의 터미널 서피스(container_exec exit-code 루프 · pty)가 진짜 차별화되는 건 high 24개**(거의 전부 SYSADMIN + 일부 security/debug).

## Skill-class 분포 (89)

| skill_class | n | terminal_native 경향 | quanta 관점 |
|---|--:|---|---|
| CODE-AUTHOR | 21 | low 13 / med 6 / high 2 | SWE 스킬 직전이 — 스펙→프로그램 합성 |
| NUMERIC-SCI | 15 | med 11 / low 4 | 과학/수치 알고리즘 — 도메인지식 병목(스캐폴드 무관) |
| SYSADMIN | 15 | **high 15 (전부)** | **quanta 터미널서피스 핵심 시험대** — 설치/빌드/설정/VM |
| ADVERSARIAL-SEC | 11 | low 6 / high 3 / med 2 | 적대적 사고(익스플로잇/우회/크랙) — 창의성 병목 |
| DATA-WRANGLE | 10 | med 6 / low 3 / high 1 | 대용량 데이터 재구조화 |
| ML-TRAIN | 9 | med 5 / low 3 / high 1 | 학습/추론 — 장시간 실행 + GPU/deps |
| DEBUG-FIX | 8 | med 5 / high 2 / low 1 | 진단→수정 — 관찰(로그/상태) 능력 |

**SYSADMIN 15개가 전부 high**인 게 핵심 패턴: 설치(install-windows-3.11), 빌드(build-pmars/build-pov-ray/compile-compcert/make-doom-for-mips), VM(qemu-*/mailman), 웹서버설정(configure-git-webserver/nginx). 이건 코드 diff로 표현 안 되는, **컨테이너 최종상태**로만 채점되는 작업 — SWE-bench가 못 잡는 축.

## Difficulty (89): medium 55 · hard 30 · easy 4

- **hard 30개**의 성격: 장시간(write-compressor 24h/gpt2-codegolf 40h expert 추정), 재현불가한 도메인(dna-assembly/protein-assembly), 진짜 크로스컴파일(make-doom-for-mips), 크립트어낼리시스(feal-*/model-extraction).
- `expert_time_estimate_min`이 5분(crack-7z-hash)~2400분(gpt2-codegolf) — **난이도 편차가 SWE-bench보다 큼**.

## 채점 특성 (SWE-bench와 다른 함정)

- **binary reward(0/1)** + task별 `tests/test_outputs.py` pytest. 코드가 아니라 **최종 산출물/파일상태/동작**을 봄.
- **anti-cheat 해시 게이트** 다수: 입력 SHA256/MD5(llm-batching·build-pov-ray·install-windows·git-leak) — 정답 하드코딩/스킵 차단.
- **정답이 solve.sh에 없거나 얇은 경우 주의**(분석 함정): regex-chess/extract-moves-from-video(정답키 echo)·adaptive-rejection-sampler(암호화된 ref 복호)·query-optimize/tune-mjcf(산출물 1줄) — solve.sh가 "진짜 풀이"가 아닌 케이스는 per-task md에 flag됨.
- **hidden test** 존재(schemelike-metacircular-eval의 shadow_test) — pass-until-green이 아니라 일반화 필요.

## quanta 실측 교차 (첫 5-task run, gpt-5.4, 2026-07-01 = 2/5)

| task | 우리결과 | skill | terminal_native | difficulty |
|---|---|---|---|---|
| reshard-c4-data | ✅ | DATA-WRANGLE | med | medium |
| break-filter-js-from-html | ✅ | ADVERSARIAL-SEC | low | medium |
| gpt2-codegolf | ❌ | CODE-AUTHOR | low | **hard(40h)** |
| llm-inference-batching-scheduler | ❌ | NUMERIC-SCI | low | hard |
| write-compressor | ❌ | CODE-AUTHOR | med | **hard(24h)** |

n=5라 신호 약하지만: **푼 2개는 medium, 못 푼 3개엔 최난도(24-40h expert)가 섞임** — 난이도 축이 결과와 일치. gpt-5.4의 천장이지 스캐폴드 문제 아님(다음: Opus 4.8 재런).

## 공략 우선순위 (quanta 관점)

1. **high-terminal-native 24개(특히 SYSADMIN 15)** — 여기가 quanta 터미널서피스가 SWE-스캐폴드 대비 진짜 이기는 구간. container_exec exit-code 루프 + pty(qemu/interactive)가 직접 먹힘.
2. **med 35개** — 코드+env; uv/deps/빌드 셋업 안정성이 관건(우리 reshard 풀었음).
3. **low 30개** — SWE 스킬 전이; 여기 못 풀면 스캐폴드가 아니라 모델/합성 문제.
4. **도메인-병목(NUMERIC-SCI 15 · 일부 ADVERSARIAL-SEC)** — 스캐폴드로 못 넘음, 모델지식 의존. measure-first로 A/B 무의미.
