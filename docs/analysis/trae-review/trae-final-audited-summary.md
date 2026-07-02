# Trae Agent — 최종 감사 정리 (적대어딧 4레인 통과본)

> 대상: ByteDance **Trae Agent** (arXiv:2507.23370, MIT OSS `bytedance/trae-agent`)
> 방식: 딥다이브 → **적대적 어딧 4레인**(Generation/Pruning/Selection/Framing·Eval·Wiring, 각 감사관은
> "REFUTE 우선" 태세로 PDF 원문 + repo 코드에 대조) → 최종 정정 반영.
> 근거 소스: 논문 PDF(pdftotext line#) + repo `trae_agent/`·`evaluation/patch_selection/` file:line.
> 관련: [../jul-1-trae-agent-deep-dive.md](../jul-1-trae-agent-deep-dive.md) · [../jul-1-external-scaffold-trigger-audit.md](../jul-1-external-scaffold-trigger-audit.md)

## TL;DR (감사 후 확정)

- Trae의 리더보드 75.20%(Verified 1위, 2025-07)는 **얇은 런타임 루프가 아니라 오프라인 앙상블**
  (generation → pruning → selection) 결과. OSS 런타임(`trae-cli run`)은 **인스턴스당 후보 1개** 생성기.
- 앙상블 3단계는 **오프라인 배치 하네스에만 존재**, 런타임 루프는 selector를 **import조차 안 함**(reverse edge 0).
- 핵심 novelty = **agent-based selector**(prompting-based 셀렉터를 tool-using 실행-근거 에이전트로 대체).
- ⚠️ 실험 모델은 **Gemini 2.5 Pro / Claude 3.7 Sonnet / GPT-4.1** = 프런티어 최상위 아님 →
  "mid-tier 모델을 앙상블로 끌어올린" 사례. 단 **75.20%의 정확한 (model, N) 미공개**
  (논문 자체 최고치는 Mixture 65.67% @ N=3, 리더보드와 ~9.5pt 갭).

## 마스터 표 (적대어딧 반영 · verdict 표기)

| # | 단계 | 컴포넌트/메커니즘 | 하는 일 | 학술 정당화 | 비용·통제 | 근거(논문 line# / repo file:line) | verdict | quanta(v7) 대응 |
|---|------|------------------|---------|-------------|-----------|-------------------------------------|---------|------------------|
| 0 | 프레임 | optimal solution search | 후보공간서 정답 탐색 문제로 **개념** 프레이밍 | **수식/정리 없음, 실증논문** (SBSE 모티프 차용) | — | PDF L20,89,123 / grep에 theorem·argmax 부재 | CONFIRM | acceptance 문제정의와 동형 |
| 0b | 프레임 | Oracle / Average / Adversary | N↑ → Oracle↑, Average 평평, Adversary↓ | Oracle-Avg 간격↑=셀렉터 여지, Adversary↓=pruning 필요 | — | PDF L153-155(Oracle +20.80% vs Avg @N=10), L161-163(**Adversary −27.01% *relative to Average*, 절대감소 아님**) | CONFIRM* | breadth-fanout이 pruning+select 둘 다 필요한 논리 동일 |
| 1 | **Generation** | coder agent (단일) | 이슈당 후보 N개 생성 | Oracle 상한 위해 diversity | N=비용선형 | PDF L438-440(N=ensemble size, "pre-defined N 도달까지") | CONFIRM | repair-breadth perCandidateSeed |
| 1b | Generation | diversity 레버 | ①**high-temp 샘플링 × 단일agent 독립 반복실행** ②**Mixture**=3모델 라운드로빈 | 고온+모델혼합이 후보다양성↑ | — | PDF L430-437 (모델: gemini-2.5-pro-preview-06-05 / claude-3-7-sonnet-20250219 / gpt-4.1-2025-04-14) | CONFIRM | **LOCATION_FANOUT + temperature knob** (구조적 diversity=걔네 future work 선점) |
| 1c | Generation | 자기고백 한계 | 지금은 단일agent+고온뿐, **다중 coder agent(Agentless/Moatless/OpenHands 통합)는 future work** | — | — | PDF L1548-1551 | CONFIRM | 우리 구조적 fanout 우위 가능(측정거리) |
| ⚠️ | Generation | "in parallel" 주의 | 논문은 "parallel"이라 쓰지만 실제 기술=**독립 반복 실행**(동시성 보장 아님) | — | — | PDF L92,388,401 vs L438(순차 until N) | 정정 | — |
| 2 | **Pruning** | deduplication | unidiff 파서로 normalize(공백/개행/주석 제거) → **동일 normalized면 중복 제거** | ensemble space 축소 | 정적(값쌈) | PDF L513-522 / `patch_selection` utils | CONFIRM | vote-key-normalize (랜딩됨) |
| 2b | Pruning | **regression testing** | 원본서 통과하던 테스트 깨는 faulty 후보 제거 | Adversary 하한 개선 | 테스트 실행비 | PDF L531-544, **L535 "Following [Xia 2025]=Agentless"** / README.md:10,51 "refer to Agentless" | CONFIRM | repro-vote / regression-select (동계열) |
| 2c | Pruning | 상관 실증 | ensemble-space **크기** ↔ selection 효과 상관 | 공간과 선택정확도 강상관 | — | PDF Table 3: **Pearson r 0.73–0.91**(+ Spearman ρ 0.80–1.00, Kendall τ 0.67–1.00) | CONFIRM* | knob별 marginal 측정원리 |
| 3 | **Selection** | **agent-based selector** ★novelty | tool-using 에이전트가 샌드박스서 코드분석+테스트실행 후 winner. prompting-based(stateless/single-turn) 대체 | "첫 agent-based ensemble reasoning" | 상호작용 상한 | PDF L27-28,590-599 / `selector_agent.py:153,174-177,197` | CONFIRM | strong-oracle / acceptance-select |
| 3b | Selection | static + dynamic 이해 | **static**=이슈/패치/의존성 코드수집 · **dynamic**=자동생성 테스트 실행트레이스(단 프롬프트상 **"Optional"** = agent 재량) | 사람 program comprehension 모사(Eisenbarth 2001) | — | PDF L594-598, Fig.8 / `selector_agent.py:42-43` | CONFIRM* | selector가 test-oracle 기반인 근거 |
| 3c | Selection | 상호작용 라운드 상한 | 셀렉터↔도구 상한 | 토큰폭주 방지 | **논문 30**, ⚠️ **repo 기본 50 / README 예시 200** (불일치) | PDF L599 vs `selector.py:33-35`(default 50), README:64(200) | 정정 | — |
| 3d | Selection | **majority voting** | 셀렉터 N회 반복 → Counter 최빈 선택 | LLM 환각/분산 완화 | early-exit | PDF L655-660 / `selector_evaluation.py:216,232,247` | CONFIRM* | reproVote K-of-N |
| ⚠️ | Selection | early-exit 정정 | 논문="첫 ⌈N/2⌉ **만장일치**면 즉시반환". **코드=`>num_candidate/2` strict-majority를 매 iteration 후 체크**(N=10이면 ≥6표). 또 코드 iteration은 **순차**(논문 "parallel"과 불일치), 동점 tiebreak=**첫 원소**(논문=random) | — | — | PDF L80-82 vs `selector_evaluation.py:232,247` | 정정 | — |
| 4 | 평가 | vs 4 SOTA 앙상블 | Augment / Aug+Prune / DeiBase / DeiBase+Prune | Wilcoxon signed-rank(p<8e-6) | — | PDF L110-111,1011 | CONFIRM | A/B는 우리 SWE f2p로 |
| ⚠️ | 평가 | 개선폭 정정 | **Table 1(N=3) 범위 = 5.01–12.86%**. 흔히 인용되는 **+5.83~14.60%(평균 +10.22%)는 N∈[1,10] 스윕(Fig.10)/초록** 숫자 — 표 혼동 주의 | — | — | PDF L1010(Table1) vs L1043,26(sweep/abstract) | 정정 | — |
| 4b | 평가 | ablation 5변종 | woD/woR/woP/**Trae Agent_A**(셀렉터→Augment 프롬프팅 대체, "wo" 아님)/woM 각각 하락 | 모든 컴포넌트 기여 | — | PDF Table 2, L1204-1217,1289-1298 | CONFIRM* | knob marginal value 원리 동일 |
| 4c | 평가 | 리더보드 | **75.20% Verified 1위(2025-07)** | mid-tier모델+앙상블이 모델격차 메움 | — | PDF L28,130,1502; ⚠️ **정확한 (model,N) 미공개**(논문 자체 최고 65.67%@N=3) | CONFIRM | — |
| ★ | 배선 | runtime vs offline | 앙상블 3단계 **전부 오프라인 배치**. 런타임 `run_evaluation.py`=인스턴스당 `trae-cli run` **1회 → 패치 1개**. selector 참조 grep=**0**(reverse edge 없음) | — | — | PDF L291-297,352-376 / `evaluation/patch_selection/` standalone CLI | CONFIRM | **우리는 런타임 통합**(차별점) |
| ✓ | 런타임 | 유일 코드 게이트 | 앙상블 밖 런타임의 유일 하드게이트=**must_patch 빈-diff veto**(eval ON). reflection=`return None` no-op(셀렉터와 무관, SelectorAgent는 별도 클래스) | — | — | `trae_agent.py:176-178,236-249` | CONFIRM | no-patch-breaker 유사 |

\* = CONFIRM이나 정밀도 주석 있음(위 표의 굵은 주석 참조).

## 적대어딧 정정 로그 (내 이전 요약 → 감사 후)

| 항목 | 이전 진술 | 정정 |
|---|---|---|
| D3 개선폭 | "+5.83~14.60%가 Table 1(N=3)" | **Table 1(N=3)=5.01–12.86%**; 5.83–14.60%는 N∈[1,10] 스윕/초록 |
| B2 pruning 정당화 | "Oracle 보존하고 Adversary만 잘라냄" | 이건 **내 추론**; 논문은 "reduce space, preserve promising"까지만 명시 |
| B4 상관 | "ensemble-space **축소** ↔ 선택효과, Pearson r" | 상관 대상=ensemble-space **크기**; Spearman/Kendall도 존재 |
| C3 30라운드 | "30 라운드 상한" | 논문=30, **repo 기본 50 / README 예시 200** 불일치 |
| C4 early-exit | "첫 ⌈N/2⌉ 만장일치면 즉시반환" | 논문 문구는 맞으나 **코드=`>N/2` strict-majority**, iteration **순차**, tiebreak **첫 원소** |
| C2 dynamic | "테스트 실행으로 dynamic 이해" | 프롬프트상 **"Optional"** = agent 재량(매 iteration 보장 아님) |
| D2 27.01% | "Adversary가 27% 떨어짐" | **Average 대비 상대** 감소(절대 아님); Oracle은 Avg 대비 +20.80% |
| A3 parallel | "N개 병렬 생성" | 논문 단어일 뿐, 실제=**독립 반복 실행**(동시성 보장 아님) |
| 4c 모델 | (모델 불명확) | 실험=**Gemini 2.5 Pro / Claude 3.7 Sonnet / GPT-4.1**; 75.20% config 미공개 |

## 연구 방법론 (논문 §4, PDF 원문 대조)

RQ 중심 실증연구 — 이론 정식화 없음.

**연구질문 (RQ 4개)**
- RQ1 전체 효과(vs 4 베이스라인) · RQ2 하이퍼파라미터(ensemble size N) · RQ3 컴포넌트 기여(ablation 5변종) · RQ4 ensemble space→selection 상관 (PDF L671-676)

**벤치마크** (PDF L679-695)
- **SWE-bench Verified 500개** (full 2,294는 "저품질·노이즈" 이유로 배제, OpenAI 사람검증 서브셋).
- 입력 = 이슈 설명 + 원본 codebase만. **regression test도 원본 codebase 것만** 사용(fair/realistic 강조).
- 채점 = **공식 SWE-bench Docker 환경**.

**메트릭** (PDF L696-704, L148-152)
- 주메트릭 = **Pass@1** — 선택된 **단일** 패치가 golden test 전부 통과 시 resolved ("stringent" 명시).
- 참조 3종(Zhang 2024a 차용): **Oracle**=N개 중 정답 있으면 항상 골라짐(상한) · **Adversary**=N개가 **전부** 정답이어야 solved(하한) · **Average**=무작위 1개 기대값.
- 경험적 토대: "resolution rate는 반복실행 간 안정적이나 **풀리는 이슈 집합은 실행마다 변함**" → 이 분산이 앙상블 여지. N=10서 Oracle +20.80% / Adversary −27.01% (둘 다 Average 기준 **상대값**).

**모델·베이스라인** (PDF L716-730, L705-715)
- 생성 모델 3종: Gemini 2.5 Pro(preview-06-05) / **Claude 3.7 Sonnet**(20250219) / GPT-4.1(2025-04-14). Claude 3.7이 최고여서 **모든 기법의 base model로 채택**(공정비교), 나머지 파라미터 default.
- 베이스라인 4개: Augment(LLM-as-judge) · DeiBase(justification+confidence) · +각각 Trae pruning 붙인 강화판 2개.
- ⭐ **공정성 설계**: 모든 기법을 **동일 후보 패치 세트**(Trae generation 산출물)로 평가 → **selection 기여만 순수 격리**. 방법론적 최강점.

**통계·재현** (PDF L997-998, L1011-1012)
- Table 1 메인 = **N=3**, 각 실험 **3회 반복**. **Wilcoxon signed-rank**(α=0.05, 실제 p<8×10⁻⁶). RQ4 상관 = Pearson r / Spearman ρ / Kendall τ **3종 다** 계산.

**감사 주의**: 이 방법론의 자체 최고치 = **Claude 3.7 base, Mixture, N=3 → 65.67%**. 리더보드 **75.20%는 이 세팅이 아님**(미공개 대형 config) → 논문 본문 방법론 ≠ 리더보드 숫자.

## quanta(v7) 시사 — 감사 후 확정

1. **흡수할 신기술 0.** v7 오라클 스택과 **완전 동계열**: repro-vote≈regression, acceptance/strong-oracle≈agent-selector, reproVote≈majority. Trae는 오프라인 3단계 분산, 우리는 런타임 통합.
2. **배울 각도 2개(측정거리)**:
   - **early-exit 최적화** — strict-majority 조기종료로 셀렉터 비용 절감(우리 reproVote에 적용 검토).
   - **구조적 diversity 우위** — Trae diversity가 "단일agent 고온샘플링"뿐이고 다중 agent는 **자기들 future work**. 우리 LOCATION_FANOUT(구조적)이 이론상 앞섬 → A/B로 확인.
3. **정직성 앵커**: "얇은 스캐폴드로 SOTA"는 신화. SOTA 숫자(75.20%)는 무거운 오프라인 앙상블 + 미공개 대형 config. Verified는 이미 포화(2026 상위 ~95% 모델레이스), 스캐폴드 변별은 SWE-bench Pro로 이동.
