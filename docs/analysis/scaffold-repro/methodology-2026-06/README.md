# 2026-06 상위권 스캐폴드 방법론 × 우리 준비도 — 종합

> 6개 병렬 어딧(TEX-T / L\*Agent / OpenHands / ReProAgent / repro-specific / grading-oracle)의 종합.
> 각 방법론은 원본 근거(논문 페이지·코드 file:line·predictions·blog)로 박혀 있고, 우리(quanta) 대응물은
> `src/` grep으로 있음/없음/미측정 태그. 세부는 스캐폴드별 문서 참조. **조합 설계용 재료 카탈로그.**

| 문서 | 스캐폴드 | 핵심 방법론 |
|---|---|---|
| [tex-t.md](tex-t.md) | TEX-T 87% | cross-candidate C×T 실행 격자 |
| [lstar.md](lstar.md) | L\*Agent 84% | best-of-N by own tests + coverage-signal + abstain gate |
| [openhands.md](openhands.md) | OpenHands 79.8% | 워크플로 프롬프트 + tool 런타임 (repro 전용엔진 없음) |
| [reproagent.md](reproagent.md) | ReProAgent 69.7% | cheap LLM viability pre-filter + code-KG |
| [repro-specific.md](repro-specific.md) | Echo/Otter/e-Otter++/AssertFlip | flip / morph×mask / dual-version / exec-augmented repair |
| [grading-oracle.md](grading-oracle.md) | SWT/TDD-bench | fail-to-pass·base-subtraction·change-coverage·곱셈게이트 |

---

## A. 이미 있음 — 측정만 하면 되는 것 (default-OFF·미측정)

| 방법론 | 출처 | 우리 코드 | 상태 |
|---|---|---|---|
| best-of-N by own tests | L\*Agent | `acceptance-select.ts`, `makeAcceptanceSelectCandidates`(`driver.ts:3432`), `QUANTA_BENCH_LLM_SELECT` | 있음·미측정 |
| execution-based oracle | ReProAgent/공통 | `strong-oracle`, `acceptance` (실행 ground-truth) | 있음·미측정 |
| **regression-veto** | SWT `grading.py:220` | `regression-oracle.ts:141-147`, `selection-gates.ts:74` | **완비** |
| **vacuous-guard** | TDD 곱셈게이트 절반 | `repro-oracle-calibration.ts:107-153` | 있음 |
| N-fanout 생성 | TEX/공통 | `repair-breadth.ts:168`, `sampleBestOfN`(`sampler.ts:69`) | 있음 |
| self-reflective planning / refinement | Otter/공통 | agent-loop, `repair/index.ts`, effort-ladder | 있음 |
| code-nav grounding | ReProAgent KG | `lsp_nav/index.ts:24` (ReProAgent dead-CALLS보다 상위호환) | 있음 |
| sticky-red (reproduce 절반) | L\*Agent gate 절반 | `bench-gap-1.ts:69`, base-RED `extract-issue-repro.ts` | 부분 |

→ **재료는 이미 손에 많다.** 이 축들은 "새로 만들기"가 아니라 "번들로 켜서 측정".

## B. 진짜 없음 — 흡수 후보 (★ = ROI 우선순위, 근거 박음)

| # | 방법론 | 출처·근거 | 우리 상태 | 왜 중요 |
|---|---|---|---|---|
| ★★1 | **AssertFlip flip trick** (passing 테스트→assertion만 issue 정답으로 flip) | AssertFlip paper, ablation **−19%p** | **grep 0 (전무)** | synthesis 수렴 병목 직결 — "정답 값 합성" 부담 우회 |
| ★★2 | **change-coverage ΔC 곱셈게이트** (gold 변경 라인 실행 커버율 × fail_before × pass_after) | TDD `run_evaluation.py:731-740`, SWT `grading.py:226-294` | **전무** (우리 coverage는 family/owner뿐, line-exec ΔC 항 없음) | over-narrow/false-green을 **수치로 거르는 유일 규율** |
| ★★3 | **행동적 abstain gate** (no-action을 success로 reframe) | L\*Agent/SRI: reproduce-alone은 **−13pp**, +28pp **전부가 abstain reframe** | sticky-red엔 abstain 절반 없음 | L\*Agent 84%의 진짜 lever, 우리가 착각했던 지점 |
| ★4 | **cheap LLM viability pre-filter** (fix-free 3-dim: reproduction/logic/post-fix-viability) | ReProAgent `prompt_template.py:228-238` | 없음 (우리는 비싼 실행 oracle만) | 싼 모델로 69.7% 낸 비결, 비싼 실행 예산 앞 pre-gate |
| ★4 | **coverage-as-refinement-signal** | L\*Agent | `coverage_check` tool 있음(default-OFF), **되먹임 미배선** | 단순 pass/fail 아닌 커버리지로 정제 |
| ★5 | **TEX cross-candidate C×T 격자** (모든 fix×모든 test 실행) | TEX blog | reprovote=N-script×**1**-tree(=TEX가 열등 지목한 self-only) | peer feedback로 개선(단 게임성 주의) |
| ★5 | **e-Otter++ morph×mask diversity + exec-augmented repair** | e-Otter++ paper, ablation −21%p | 우리 diversity=temperature+location만 | 구조적 다양성 + 능동 context 수집 |

## C. 착각 정정 — 근거로 뒤집힌 것 (중요)

- **"reproduce-before-fix 60.5→88.5%"는 L\*Agent 84% lever가 아니다.** SRI 블로그의 SWE-**fix** task 수치고, reproduce-alone은 오히려 **−13pp**, +28pp의 전부가 **abstain을 success로 reframe**한 데서 온다. → 우리 sticky-red는 그 gate의 절반(reproduce)만 가짐. (근거: [lstar.md](lstar.md))
- **Echo의 간판(graph-retrieval + dual-version oracle)은 공개코드에 없다.** Prometheus 리브랜딩이고 graph는 call/import 엣지 0인 substring 트리, oracle은 LLM-judge. 실질 lever(few-shot + judge)는 우리 보유. semantica graph 흡수 정당성 못 줌. (근거: [repro-specific.md](repro-specific.md))
- **TEX cross-grid는 우리 reprovote의 상위집합이 아니라 직교다.** reprovote는 test 다양성으로 1-fix 검증(C축 격자 통째 없음). (근거: [tex-t.md](tex-t.md))
- **OpenHands엔 repro 전용 엔진이 없다.** 흡수원이 빈 우물이고, 우리가 phase-guard/repro-oracle을 오히려 더 가짐. (근거: [openhands.md](openhands.md))

## D. 못 바꾸는 지배 드라이버 (인정)

- **model 강도** (same-model same-style 12.8pp), **repo 난이도** (40~70pp 스윙). 위 lever 전부를 dwarf → addressable gain은 **modest**.

---

## E. 🔴 최종 어딧 교정 (적대 3바퀴 → 위 B/A 상당수 무너짐)

> 3각도 적대 어딧([audit/adversarial-gaps-transfer.md](audit/adversarial-gaps-transfer.md) ·
> [adversarial-mapping.md](audit/adversarial-mapping.md) · [adversarial-consistency.md](audit/adversarial-consistency.md))
> 결과. 근거 조작은 0(8/8 인용 정확)이나 **결론 상당수가 카테고리 오류로 강등·사망.**

**B의 "신규 흡수 갭 3개" → 직접 f2p lever 0개 (핵심 교정):**
- **①flip → ★강등 (간접).** AssertFlip은 **test-generation** 시스템(paper p.1), −19pp도 **SWT test-gen 지표**(43.6→24.2%)지 우리 f2p 아님. flip은 repro-test 합성 부담만 우회 — fix-edit은 안 써줌. "synthesis 병목 직결"은 **repro-synthesis ↔ fix-synthesis 혼동**. 우리 병목(jun-29 fix-edit 수렴)과 타겟 어긋남.
- **②change-coverage → 간접·중복 의심.** cov_score는 **테스트** 품질 항(fix 아님), resolved 경계에선 "변경라인 1줄 밟나" binary. 우리 repro-resolved가 이미 함의 → 추가변별 중복 가능. "over-narrow fix 거르는 유일규율"은 **테스트 over-narrow ↔ 패치 over-narrow 혼동**(우리 false-green root는 assertion-pin/sticky-red가 더 정확히 침).
- **③abstain → 사망.** SWE-bench는 **recall(고정 분모)**, abstain은 **precision 재정의(분모 조작)**(AssertFlip §5.2 189/326 vs 189/433). 빈 패치=fail([[jun-20-leaderboard-throttle-miss-confound]] 측정구멍). abstain 실제 기전=회귀 veto인데 그건 우리 이미 보유. 순수 abstain=recall 순손실. **문서 내부 모순도 적발**(lstar §1e "SWT lever 아님" ↔ README "진짜 lever").

**A의 "regression-veto 완비" → 부분(opt-in soft·미측정)으로 강등 (overclaim):**
- cited `selection-gates.ts:74`는 veto 아니라 accept-proof 자리. veto 파일은 `@deprecated jun-27`·`verifySelectN` 어떤 preset도 안 set = **inert(도달불가)**. 라이브 대체(acceptance regression)는 `agentless-v6-oracle` opt-in의 **soft min-count tie-break**이지 SWT hard ×→F 곱셈게이트와 **비동형**. (역설: SWT식 hard 곱셈게이트는 우리한테 **진짜 없음** — 단 채점용은 harness 대행, selection용 가치 미검증.)

**HOLDS (적대 통과):** best-of-N by own tests(단 우리는 binary vote라 값-pin 약함) · abstain 정정 자체(SRI verbatim, 에이전트 행동·모델명 GPT-5.4-mini 정정) · Echo/TEX/OpenHands 착각정정 4건 · 근거 실재성.

## 조합 설계용 한 줄 (최종 어딧 반영)

- **살아남은 "직접 f2p lever" = 사실상 0개 신규.** 신규 갭 3개는 test-gen 벤치 lever를 patch-생성 lever로 오승격한 **카테고리 오류**였다. round3 결론(**측정레일부터 · 이미 만든 것(best-of-N/oracle/regression) 측정 · gain modest**)을 이번 종합이 **못 뒤집었고, 오히려 재확인**.
- **본체 번들 (이미 있음, 측정만):** best-of-N × execution-oracle × (regression-guard=opt-in soft) × vacuous-guard. 이걸 SWE f2p로 A/B가 정공법.
- **신규 흡수는 보류** — flip/change-coverage는 측정 전 정당성 없음(간접), abstain은 우리 채점과 충돌(사망). graph/tool-guide/insertion/multi-test/assertion-강화는 이미 NULL 확정.
- **이번 어딧의 진짜 소득 = "새 갭"이 아니라, 새 갭이라 착각한 것들이 test-gen↔patch 카테고리 오류임을 잡아낸 것.** (이 세션 반복 패턴: 새 흡수처럼 보이면 적대검증 시 무너지고, 남는 건 "이미 있는 것 측정".)
