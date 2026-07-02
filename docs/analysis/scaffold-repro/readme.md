# Repro 스캐폴드 코드레벨 해부 — 종합 (overview)

> 분석일: 2026-07-01. 대상: SWT-bench / TDD-Bench Verified 리더보드 상위 issue-reproduction
> test-generation 스캐폴드들. 목적: quanta-codeagent-v3의 repro/TDD 흡수를 위해 "쟤네가
> 실제 코드에서 어떤 동작으로 repro를 만드는지" file:line 근거로 해부하고, 우리 흡수 레버와
> 측정 레일 부착 경로를 확정한다.
>
> **증거 원칙:** 모든 주장은 clone된 실제 소스(`.extracted_source/repro-scaffolds/`)의
> file:line 인용에 묶인다. `[verified]`=원본 직독, `[inferred]`=코드 정황 추론,
> `[reverse-engineered]`=출력 아티팩트 역공학(소스 비공개).

## 이 폴더 구조

| 문서 | 내용 |
|---|---|
| `readme.md` (이 문서) | 전반 설명 + 4개 교차 비교 + 🔴핵심 발견 + 결론 |
| [`reproagent/readme.md`](reproagent/readme.md) | ReProAgent 멀티에이전트 파이프라인 + symbol-KG 해부 |
| [`echo/readme.md`](echo/readme.md) | Echo(실체=Prometheus) graph+verifier 해부 |
| [`swt-bench/readme.md`](swt-bench/readme.md) | SWT-bench 채점 하네스 — 측정 레일 청사진 |
| [`tdd-bench-otter/readme.md`](tdd-bench-otter/readme.md) | TDD-Bench 채점 + Otter/Otter++ 역공학 |
| [`measurement-rail.md`](measurement-rail.md) | 🔧 SWT vs TDD 측정 레일 부착 결정 (cross-cutting, *예정*) |
| [`absorption-backlog.md`](absorption-backlog.md) | 📥 4개에서 뽑은 흡수 레버 통합·우선순위 (cross-cutting, *예정*) |
| [`predictions-review/lstar.md`](predictions-review/lstar.md) | 🥇 L\*Agent 84% 실물 predictions 정성+정량 리뷰 |
| [`predictions-review/tex-t.md`](predictions-review/tex-t.md) | TEX-T 87% script-mode 실물 predictions 리뷰 |
| [`predictions-review/reproagent.md`](predictions-review/reproagent.md) | ReProAgent 70% 새파일 격리 실물 predictions 리뷰 |
| [`predictions-review/otter-assertflip.md`](predictions-review/otter-assertflip.md) | e-Otter++ 62% / AssertFlip 45% 비교군 리뷰 |
| [`best-practice-repro-loop.md`](best-practice-repro-loop.md) | 🔁 repro 생성 loop 베스트 프랙티스 + 시퀀스 다이어그램(통합형 + 경쟁사 4종 각각) |

## 📦 증거자료 (Evidence — 전부 로컬 보관, 재현 가능)

> 모든 1차 자료(코드·논문·실물 predictions)를 받아 `.extracted_source/repro-scaffolds/` 아래
> 보관했다. 본 분석의 모든 주장은 이 자료로 재검증 가능.

### 1. 코드 (clone, `.extracted_source/repro-scaffolds/`)
| 디렉토리 | 출처 | 비고 |
|---|---|---|
| `reproagent/` | github iSEngLab/ReProAgent | 완전 멀티에이전트 소스 + `outputs_gpt_5_mini/` 실물 predictions |
| `echo/` | github EuniAI/Echo | 실체=Prometheus(논문 핵심 2개 코드에 없음) |
| `swt-bench/` | github logic-star-ai/swt-bench | 채점 하네스(NeurIPS 2024) |
| `tdd-bench-verified/` | github IBM/TDD-Bench-Verified | `Otter/`는 결과 json만(코드 비공개) |

### 2. 논문 PDF (`_papers/`)
| 파일 | arXiv | 시스템 |
|---|---|---|
| `echo_2603.07326.pdf` | [2603.07326](https://arxiv.org/abs/2603.07326) | Echo |
| `e-otter++_2508.06365.pdf` | [2508.06365](https://arxiv.org/abs/2508.06365) | e-Otter++ |
| `otter_2502.05368.pdf` | [2502.05368](https://arxiv.org/abs/2502.05368) | Otter (ICML 2025) |
| `swt-bench_2406.12952.pdf` | [2406.12952](https://arxiv.org/abs/2406.12952) | SWT-bench (NeurIPS 2024) |
| `tdd-bench_2412.02883.pdf` | [2412.02883](https://arxiv.org/abs/2412.02883) | TDD-Bench Verified |
| `assertflip_2507.17542.pdf` | [2507.17542](https://arxiv.org/abs/2507.17542) | AssertFlip |
| (논문 없음) | — | **TEX-T**=[Salesforce blog](https://www.salesforce.com/blog/tex-test-time-scaling/)만 · **L\*Agent**=[LogicStar blog](https://logicstar.ai/blog)만 |

### 3. 실물 Predictions (ground-truth, 생성된 실제 테스트)
| 파일 (`_predictions/` 또는 명시) | 시스템 | 점수 |
|---|---|---|
| `_predictions/lstar_agent_verified.json` | L\*Agent | 84% |
| `_predictions/tex-t_verified.jsonl` | TEX-T | 87% (script) |
| `_predictions/eotter_plus_verified.inference.json` (+`.evaluation.json`) | e-Otter++ | 62% |
| `_predictions/assertflip_verified.preds.jsonl` (+`.evaluation.json`) | AssertFlip | 45% |
| `reproagent/outputs_gpt_5_mini/repro_agent_preds_gpt_5_mini_verified.jsonl` | ReProAgent | 70% |
| 원본 호스팅 | ETH SRI: `files.sri.inf.ethz.ch/swt-bench/inference_output/swt-verified/` |

### 4. 리더보드 / trajectory 원본
- 리더보드: [swtbench.com/?results=verified](https://swtbench.com/?results=verified)
- Agent traces(baseline만 — Aider/OpenHands/SWE-Agent, 상위권은 predictions만): `files.sri.inf.ethz.ch/swt-bench/agent_traces/`

## 분석 대상 (공개 소스만)

| 스캐폴드 | SWT-bench Verified | 모델 | 소스 | 성격 |
|---|---|---|---|---|
| **ReProAgent** (난징대) | 69.7% (unit-test) | GPT-5-mini | 완전 공개 | 멀티에이전트 + symbol-KG |
| **Echo→Prometheus** | 66.3% (논문값) | Gemini 2.5 Pro | 공개(but 리브랜딩) | graph + LLM verifier |
| **SWT-bench** (LogicStar) | — (하네스) | — | 완전 공개 | 측정 하네스 |
| **TDD-Bench + Otter** (IBM) | — / Otter는 TDD-Bench | GPT-4o(Otter) | 하네스 공개, Otter는 결과json만 | 측정 + 역공학 |

**비공개라 못 깐 것:** L\*Agent v1(84%, LogicStar), TEX-T(87% script-mode, Salesforce),
e-Otter++(62%, IBM) — 전부 blog·paper만.

---

## 🔴 핵심 교차 발견 (3-라운드 적대 어딧으로 수정됨)

> **2026-07-01 정정:** 코드-해부 직후의 첫 인상("existing-file insertion + fixture reuse가 repro
> 최강 단일 레버")은 per-instance resolved 라벨로 3라운드 적대·객관 검증한 결과 **반증됐다**. 아래는
> 어딧된 결론이다. 풀 synthesis = [`audit/round3-synthesis.md`](audit/round3-synthesis.md).

### 0. insertion은 레버가 아니라 NULL — multi-test·assertion-strength도 동반 강등
- **insertion-as-lever = FALSIFIED.** L\*Agent **단일 model+scaffold** 안에서 insert 81.7% vs
  new-file 79.2%, existing vs new **Fisher p=1.0, OR=1.014**. within-repo 9/9 repo 전부 p≥0.158,
  delta 부호조차 뒤집힘. 실패의 **94.7%가 insert**(insert는 fail을 못 막음). 진짜 인과 insert-win은
  전 데이터셋 **2/500=0.4%**(shared test-infra 파일 편집만). insertion = "최강 레버"가 아니라
  **coverage 바닥을 높이는 값싼 깔개.**
- **multi-test-as-lever = FALSIFIED.** resolved/unresolved 평균 test-fn **둘 다 1.47로 동일**,
  single-test resolved ~98%. 필요한 건 *여러* 개가 아니라 *맞는* 1개.
- **assertion-STRENGTH-as-lever = FALSIFIED.** within-system-within-repo **p=0.08(비유의)**,
  "약한단언 resolved & 강한단언 failed"가 그 반대만큼 잦음(**non-monotonic 53%**). cross-system
  상관은 Simpson 역설(약한 모델이 substring 다량 방출).

### 0-b. 지배 드라이버 = 우리가 못 바꾸는 repo + model (addressable lever를 압도)
- **repo 난이도(1차):** sphinx ~18-30% vs scikit ~67-92%. repo 내부 격차 < repo 간 격차.
- **model+scaffold(2차):** **같은 gpt-5-mini·같은 new-file 스타일인데 ReProAgent 70.3% vs
  OpenHands 57.5% = 12.8pp.** style 효과라 주장될 어떤 cross-system 격차보다 크다.
- → 이 둘이 우리가 측정한 모든 addressable lever를 dwarf. 현실적 addressable headroom = **modest.**

### 0-c. 살아남은 진짜 레버 = localization-targeting + vacuous-guard + oracle-loop 번들
- **localization-targets-gold (confidence HIGH):** 생성 테스트가 gold 코드경로를 import·실행하면
  resolved **+20.2pp pooled**(χ²=42.3, p≪0.001, OR=2.33), **within-repo 통제 후 +15.1pp 생존**
  (django 단독 +23pp). directory는 cosmetic, **import/symbol targeting이 load-bearing.**
- **assertion-CORRECTNESS / vacuous-guard (confidence MED):** prompt로 회수 가능 headroom ≈ **13% 상한**
  (vacuous 3% 확실분 + weak-when-strong-available 10%); 나머지 87%는 strong-but-wrong = model-bound.
- **surrogate-oracle exec-review loop (confidence MED, 갭 정렬 HIGH):** 우리 synthesis-convergence
  갭(단일-pass→틀린 edit false-green 정지)에 정렬된 **유일한 직접 lever.** 위 둘은 이 루프의
  입력·출력 게이트. 단 **단독 배선 시 false-green 악화**라 (loc-gate × vacuous-guard)와 묶어야 생존.

### 1. "graph grounding" 환상이 무너졌다
우리는 "상위 repro 스캐폴드가 code-graph로 grounding한다 → 우리도 semantica-codegraph
붙이자"로 출발했다. **실제 코드를 까보니 진짜 semantic graph를 쓰는 스캐폴드가 하나도 없다.**

- **ReProAgent**: symbol-KG는 있으나 `CALLS`/`REFERENCES` edge가 **dead** — `self.calls`는
  절대 안 채워지고 tags 로딩이 주석 비활성, `tags.msgpack`은 로드 직후 삭제. 살아있는 건
  `BELONGS_TO`/`HAS_METHOD`/`HAS_VARIABLE`/`INHERITS` **구조 관계뿐**(call graph 아님). 게다가
  LLM에 노출되는 KG 도구는 2개(`FindRelatedEntities`+`SearchFilesSmart`)뿐이고 후자의 KG
  검색은 O(N) substring brute-force라 grep과 중복. [verified, 상세 reproagent 문서]
- **Echo(Prometheus)**: graph edge가 `HAS_FILE`/`HAS_AST`/`HAS_TEXT`/`PARENT_OF`/`NEXT_CHUNK`
  뿐 — call/import/def-use edge **전무**. retrieval은 Cypher/embedding이 아니라 in-memory
  substring 매칭(`if text in node.node.text`, 상위 5개 cap). AST depth 기본 1이라 사실상
  파일별 top-level 심볼 인덱스. **우리 grep+read보다 열등한 부분집합.** [verified, 상세 echo 문서]

→ **함의:** "graph가 SOTA의 비결"이라는 전제가 코드 레벨에서 반증됐다. 동시에 이건
**아무도 진짜 깊은 그래프(call/dataflow/points-to)를 안 써봤다**는 뜻 — semantica를 붙이는 게
*기회*일 수는 있으나, 그 정당성은 "쟤네가 쓰니까"가 아니라 **우리가 직접 측정으로 증명**해야
한다. ([[no-heuristics-only-validated]] 그대로, 오히려 더 강해짐.)

### 2. 공통의 진짜 lever = execution-feedback + LLM verifier(surrogate oracle)
graph를 걷어내면 4개가 수렴하는 실제 동력은 동일하다:
- **생성한 테스트를 실행**하고, 실패 로그를 **피드백으로 다시 넣어 repair**.
- 골드 fix가 없으니 **LLM verifier**가 "이 테스트가 issue를 진짜 재현하나(맞는 이유로 fail하나)"를
  판정해 accept/regenerate (ReProAgent의 execution-review, Echo의 bug-reproducing verifier).
- 이건 우리 메모리의 "오라클 루프 부재 = 레버 #1"([[jun-29-gap-essence-synthesis-convergence-bottleneck]])을
  코드 레벨에서 재확증한다. 그리고 이 lever는 graph 없이 우리 **acceptance/submit-review seam
  위에 바로 얹힌다**([[jun-28-reprovote-to-acceptance-sota]]).

### 3. 공개 코드 ≠ 논문 (검증 안 하면 속는다)
- **Echo로 받은 repo는 실체가 "Prometheus"** — 논문이 1급 기여로 내세운 self-generated
  fix-patch oracle과 dual-version check가 **코드에 아예 없다**(grep 전수 0건). 논문 ablation의
  +7.16pt는 이 코드로 재현 불가. 즉 리더보드 점수의 출처 코드가 공개본과 다를 수 있다.
- **ReProAgent README의 "Triadic Review"**도 3-voter 앙상블이 아니라 단일 LLM이 3개 dimension을
  평가하는 unary review. 흡수할 때 "3중 투표"로 오해하면 안 됨.
→ 흡수 결정은 **README/논문이 아니라 코드 동작**을 SSOT로.

### 4. 채점 설계가 우리 false-green 문제에 직접 대응한다
- **TDD-Bench**: `final_score = cov_score × fail_before × pass_after` — 단순 통과가 아니라
  **변경코드 coverage를 곱하는 연속 스코어**. over-narrow/가짜-green을 수치로 차단. 게다가
  예측이 추가/수정한 **test 함수 nodeid만** 실행(contributing-test-only). [verified]
- **SWT-bench**: 모든 instance를 **6× 컨테이너**((pred/gold/base)×(pre/post))로 돌려 base를
  빼서(base-subtraction) flaky transition을 상쇄. success = "base 대비 ≥1 추가 F→P AND ×→F
  regression 0". [verified]
→ 둘 다 우리가 데였던 false-green([[jun-28-closure-repair-false-green-root]])을 막는 채점 규율을
  코드로 제공. 이게 측정 레일로 가져올 핵심 자산.

---

## 한 줄 결론 (3-라운드 어딧 후)

> **insertion은 점수의 인과 판별축이 아니다**(within-system Fisher p=1.0) — multi-test(1.47=1.47)·
> assertion-strength(p=0.08, non-monotonic 53%)와 함께 null로 강등된다. 점수 분산을 지배하는 건
> **우리가 못 바꾸는 repo 난이도(1차)와 model+scaffold(2차, same-model same-style만으로 12.8pp)**이고,
> 우리가 실제로 당길 separable lever는 (1) **localization-targeting**(생성 테스트가 gold 코드경로를
> import·실행; within-repo causal +15pp), (2) **vacuous-oracle 정적 거부 위생 가드**(~3% 확실분),
> (3) 이 둘을 입력·출력 게이트로 삼는 **surrogate-oracle execution-review 루프**(우리
> synthesis-convergence 갭에 정렬된 유일한 직접 lever)뿐이다. 셋의 합산 headroom은 지배 드라이버에
> 비해 **modest**다. → **Decision:** (H)oracle-loop × (C)loc-gate **2×2 + vacuous-guard rider,
> default-OFF** A/B를, **docker-free swt-bench `grading.py` 측정 레일**(get_resolution_success는 순수
> 함수, docker 불요·coverage optional) 위에서 serial 채점. insertion/multi-test에 측정 예산 금지(분자 0).
>
> (부수 확증은 유지: **graph가 아니라 execution-feedback + verifier가 SOTA 동력**, 공개 graph 스캐폴드
> 둘 다 graph를 사실상 안 씀 → semantica는 버리지 않되 "쟤네가 쓰니까" 정당성은 폐기. 측정 레일은
> TDD-Bench 신규 도입 불요 — 이미 가진 `grading.py`로 충분.)

세부는 [`absorption-backlog.md`](absorption-backlog.md)(흡수 레버·우선순위)와
[`measurement-rail.md`](measurement-rail.md)(측정 레일 부착) 참조.
