# Round-3 FINAL ADVERSARY — 수렴된 결론을 마지막으로 친다: "이거 우리가 이미 한 거 아니냐"

> 작성일 2026-07-01. 3-라운드 적대 어딧의 최종 라운드. 입력: `audit/round1-*.md`, `audit/round2-*.md`,
> `predictions-review/{lstar,otter-assertflip,reproagent,tex-t}.md`, swt-bench 소스(`grading.py`/`log_parsers.py`/`run_evaluation.py`),
> 그리고 **우리 프로젝트 메모리**(jun-28-oracle-first / jun-28-reprovote-to-acceptance / jun-28-closure-repair-false-green / jun-29-repro-gen-grounding / jun-29-gap-essence).
> 공격 대상 = Round-2가 수렴시킨 결론: **"insertion/multi-test/assertion-strength = NULL; addressable lever = (C) localization-targeting + (H) surrogate-oracle 루프 묶음; 지배인자(repo/model)는 못 바꿈."**
> 임무: 이 결론이 **우리에게 NEW/actionable한가**, 아니면 **이미 한 걸 재발견**한 것인가를 적대적으로 판별.

---

## 0. 한 줄 — 이 어딧이 우리 계획에서 ACTUALLY 바꾸는 것

**거의 없다. 새 lever를 주지 않는다.** (H) 오라클 루프·(C) 로컬라이제이션 게이트·grounding·acceptance 재정렬은 **전부 이미 main에 랜딩됐고 전부 default-OFF·EFFECT-UNMEASURED**다(메모리 5개가 증언). 따라서 이 어딧의 진짜 결과물은 "**무슨 lever를 지어라**"가 아니라 **"우리가 이미 지은 걸 아직 안 쟀다 → 병목은 새 lever가 아니라 측정 rail이다"**이다. 단 하나 *진짜로 새로운* 산출물은 §3에서 까발린 **측정 rail의 비용 정정**: Round-2가 "docker-free pure-python 채점기 보유"라 판 건 **틀렸다** — swt-bench 채점은 인스턴스당 **6회 실행**(`pred_pre/pred_post/gold_pre/gold_post/base_pre/base_post`, post 3개는 gold CODE 패치 적용 후 실행)을 요구한다. pure-python인 건 마지막 산술(`get_resolution_success`)뿐이고, 그 입력을 만드는 데 박스 실행이 그대로 필요하다. **즉 이 어딧이 바꾸는 단 하나 = "싸게 잴 수 있다"는 착각을 제거하고 측정 비용을 정직하게 6-run으로 재책정한 것.** 나머지는 전부 "가서 이미 만든 걸 측정하라"로 환원된다.

---

## 1. "Nothing new" attack — 어딧 결론 vs 이미 랜딩한 것의 정면 diff

어딧이 ROI #1~#3로 민 것을 메모리의 랜딩 사실과 1:1로 맞댄다.

| 어딧 결론(round2-actionable-roi) | 우리가 이미 한 것(메모리) | 상태 | NEW? |
|---|---|---|---|
| **(H) surrogate-oracle exec-review 루프 = ROI #1, "배선만 남음"** | `jun-28-reprovote-to-acceptance-sota`: Agentless식 acceptance(score-once+패치투표+dual-guard+3tier ladder) **Phase-A 9모듈 hermetic 랜딩**, 양 드라이버 배선 LANDED(492f5efbb). `jun-28-oracle-first-fail-closed`: typed adopt SSOT `repairCandidateClears`·후보별 repro persistence **main 랜딩**. | **LANDED, default-OFF, A/B 미측정** | **NO** — 어딧이 "배선만 남음"이라 한 그 배선이 이미 끝남 |
| **(C) localization-targeting / change-coverage gate = ROI #2** | `jun-29-repro-gen-grounding-landed`: extractSignatures grounding·skeleton 주입 **6컴포넌트 랜딩**. round2-localization-lever §4가 직접 인용: "우리 change-coverage gate + extractSignatures grounding에 직결". | **부분 LANDED(grounding), change-coverage gate는 미배선** | **반쪽만 NEW** (§2 참조) |
| **(G) bootstrap recipes = ROI #3 cheap rider** | `jun-29-repro-gen-grounding`: exemplar skeleton 주입이 정확히 "관련 기존테스트 SETUP SKELETON 주입". prompt-only few-shot은 grounding의 부분집합. | **LANDED(grounding이 상위집합), 미측정** | **NO** |
| **"우리 갭 = 단일-pass가 오라클 루프 없어 틀린 edit에 false-green 수렴"** | `jun-29-gap-essence`: **이미 N=28 fail taxonomy로 경험 확정**한 동일 문장. `jun-28-closure-repair-false-green-root`: 라운드-0 false-green = 정확히 어딧 TASK4 반론1이 "재발 위험"이라 경고한 그 사건. | **이미 진단 완료** | **NO** |
| **측정 prerequisite = swt-bench grading.py 로컬 보유, docker-free** | — (메모리에 이 주장 없음) | **신규 주장, 그러나 §3에서 일부 틀림** | **YES지만 부정확** |

**판정 — "nothing new"는 거의 전적으로 survives.** 어딧 ROI #1·#3과 갭 진단은 **재발견**이다. 메모리 5개가 (H)·grounding·acceptance·false-green·gap-essence를 전부 선점한다. 어딧이 "배선만 남음(seam 보유)"이라 반복해 단 것 자체가 자백이다 — 배선이 *이미 끝났고* default-OFF로 *측정만 안 됐다*. **그러므로 어딧의 진짜 finding은 "build the oracle loop"가 아니라 "still haven't MEASURED it"**이다. 병목은 lever가 아니라 측정 rail. 이 명제를 강하게 지지한다:

- (H)·(G)·gap-진단 셋 다 메모리에 "**측정만 남음**"/"**A/B 대기**"/"**박스대기**"로 명시 표기됨. 즉 우리 자신이 이미 "지었고 안 쟀다"고 적어뒀다.
- 어딧 어디에도 "이미 랜딩됨" 사실이 반영 안 됨 — round2-actionable-roi가 (H)를 "우리가 *이미* 방향 보유 → 배선만 남음"이라 *과거형 추정*으로 적었을 뿐, **랜딩 커밋(492f5efbb 등)을 인지하지 못한다.** 어딧은 자기 결론이 이미 코드라는 걸 모른다.

**유일하게 "nothing new" attack이 *못* 죽이는 것**: 어딧은 *경쟁사 데이터로* (H)/(C)가 인과적이라는 **외부 정량 근거**(targets-gold +20.2pp χ²=42.3, insertion p=1.0)를 처음 제공했다. 이건 "지어라"가 아니라 "*이미 지은 것에 측정 예산을 어디 쓸지*"의 **사전확률**을 갱신한다 — (A)insertion/(D)multi-test에 예산 쓰지 말라는 *negative* 가이드가 실질 가치. 그러나 이조차 "새 lever"가 아니라 "측정 우선순위 정렬"이다.

---

## 2. (C) localization-gate 신규성 체크 — grounding이 이미 반쯤 지었나?

**질문**: "생성 테스트가 gold-changed 모듈을 import/실행하게 만들기"가 우리 repro-gen grounding / change-coverage로 이미 있는가?

**정직한 분해 — grounding과 (C)는 다른 지점을 친다:**

- **grounding(LANDED)** = *입력 주입*. `extractSignatures`/skeleton이 "관련 기존 테스트의 SETUP 골격"을 프롬프트에 넣어 모델이 **bootstrap을 덜 깨게** 한다(`jun-29-repro-gen-grounding`: 40% exec_failed 공략). 이건 round2가 분류한 **(G) bootstrap / (F) richer-retrieval** 축이다 — "테스트가 *돌아가게*" 만든다.
- **(C) change-coverage gate(미배선)** = *출력 선택/거부*. 생성된 테스트가 gold-changed 라인/symbol을 **실제로 커버/실행하는가**를 판정해 non-targeting 후보를 reject/repair. 이건 "테스트가 *맞는 코드경로를 친다*"를 강제하는 **selection gate**다.

**둘은 인접하나 동일하지 않다.** grounding은 입력 품질을 올려 *간접적으로* targeting 확률을 높이지만, **targeting을 검증·강제하는 게이트는 없다.** round2-actionable-roi TASK1 (C) 항목도 이걸 정확히 짚는다: "change-coverage gate(타겟라인 커버 테스트 선호/reject) + extractSignatures 확장" — 즉 **extractSignatures는 보유(grounding), change-coverage *게이트*는 미보유.**

**진짜로 missing한 것(구체):**
1. **change-coverage 판정 신호 자체** — 생성 테스트가 gold 코드패치의 added/removed 라인을 실행하는지 측정하려면 **coverage 또는 정적 호출그래프 도달성**이 필요. swt-bench `extract_changed_lines_from_patch`+coverage가 정확히 이걸 하지만(grading.py:226·347), 우리 파이프라인엔 이 신호를 selection에 먹이는 배선이 없다.
2. **reject/repair seam** — targeting 실패 후보를 버리거나 재생성 트리거하는 게이트. acceptance seam(LANDED)에 *입력 필터*로 꽂아야 하나 미배선.
3. **R2 §3-2 한계가 경고하는 함정**: "gold symbol 언급 ≠ 올바른 trigger 경로 도달"(astropy-13033). 단순 import-match 게이트는 인위호출(`_check_required_columns()` 직접)을 통과시킨다 → **호출그래프 도달성**까지 봐야 진짜 게이트. 이건 grounding이 전혀 안 건드리는 신규 작업.

**판정**: (C)는 **반쪽만 신규**다. 입력측(signature grounding)은 LANDED, **출력측(change-coverage selection 게이트 + 도달성 판정)은 진짜 미보유**. 단 ROI는 (H) 종속 — round2 본인 결론대로 (C)는 standalone 아니고 (H)의 입력 게이트라, (H) 측정 전엔 (C)만 따로 지을 이유 없다. **"이미 반쯤 지었다"가 맞고, 나머지 반은 (H) A/B 결과를 본 뒤 지어도 늦지 않다.**

---

## 3. 측정-rail reality check — "docker-free 로컬 채점기" 주장 적대 검증 (소스 정독)

round2-actionable-roi TASK5·요약#9의 핵심 판매포인트: **"swt-bench `grading.py`가 docker-free·coverage-optional·pure-python(로그+gold 세트만) → 박스 stdout→`get_logs_eval` 정규화 adapter 1개면 로컬 resolved 라벨, TDD-bench 신규 불요."** 이걸 소스로 깐다.

**부분적으로만 참 — 그리고 결정적으로 오도(misleading).**

**참인 것:**
- `get_resolution_success(report_pred, report_base)`(grading.py:205)는 **순수 함수**: base/pred의 f2p·p2f·f2f 세트만으로 resolved 산출. 맞다.
- `get_logs_eval`(grading.py:46)은 stdout 파싱, **coverage 없이도** 동작(line 74-75 분기). resolved 판정에 coverage 불요. 맞다.
- lstar `report.json`을 재채점 없이 읽은 건 사실(이미 직렬화된 출력).

**틀린/숨긴 것 (smoking gun, `run_evaluation.py:178-180`):**
```python
patch_ids   = ["pred_pre__"+id, "pred_post__"+id, "gold_pre", "gold_post", "base_pre", "base_post"]
test_patches= [model_patch,     model_patch,      gold_test,  gold_test,   None,      None]
code_patches= [None,            gold_code_patch,  None,       gold_code_patch, None,   gold_code_patch]
```
- `report_pred`·`report_base`를 만들려면 `get_eval_report(eval_PRE, eval_POST)`(grading.py:142)에 **pre/post 두 로그**가 각각 필요하다. f2p = "pre에서 FAIL → post에서 PASS"이므로 **버그 트리(pre)와 gold-fix 트리(post) 양쪽에서 같은 테스트를 실행**해야 한다.
- 즉 인스턴스당 **최소 4회 실행**(pred_pre, pred_post, base_pre, base_post; gold_pre/post는 grading만 할 거면 생략 가능하나 swt 정식은 6회). 그리고 `code_patches`의 **post 항목들은 gold CODE 패치를 repo에 적용한 뒤 실행**한다.
- **결론: "stdout만 뽑으면" = 거짓.** 후보 테스트를 (1) **base commit(깨진 코드)** 위에서 실행 + (2) **gold 코드패치 적용한 트리** 위에서 다시 실행해야 f2p 한 줄이 나온다. 이건 박스에서 **gold 코드 체크아웃 + 2회 pytest 실행**을 그대로 요구한다 — docker는 피해도 **실행(execution)은 못 피한다.** pure-python인 건 두 로그를 받은 *다음* 단계뿐.

**그래서 진짜 측정 비용(정정):**
- gold f2p 세트가 dataset에 있다(맞음) → `report_base`의 **결과 세트**는 dataset FAIL_TO_PASS/PASS_TO_PASS로 대체 가능할 수도 있으나, swt 코드 경로는 `report_base`도 **base_pre/base_post 실행으로 재산출**한다(178행). dataset 세트로 숏컷하려면 우리가 매핑 어댑터를 더 써야 하고, base 환경이 dataset 채점 환경과 동일하다는 보장이 필요(repro env era confound — `jun-29-repro-env-era` 경고).
- **per-instance 최소 2회(pred를 base-위 / gold-위) pytest 실행 + gold 코드패치 적용.** 이게 박스 비용의 본체. round2가 "박스 부담 최소"라 한 건 coverage만 끈 거지 실행 자체는 그대로다.

**판정**: round2의 "docker-free 싼 rail" 주장은 **coverage-free·docker-free까지만 참, execution-free는 거짓.** adapter는 1개로 안 끝나고 "후보 테스트를 gold-fixed 트리에서 재실행하는 박스 파이프라인"이 전제다. **이게 이 어딧에서 *유일하게 진짜 새로운* 정정**이고, 동시에 "싸게 잴 수 있다"는 낙관을 깬다. 우리 `repro-test/execute.ts`는 현재 *patched tree*(gold-fix) 위 실행은 있으나(`execute.ts:43` "patched tree"), **base-commit 위 pre 실행 + f2p 차분**을 swt 포맷으로 내보내는 배선은 미확인 → 그게 측정 rail의 실제 미싱 부품.

---

## 4. Over-fitting to SWT-bench — repro 점수 쫓는 게 우리 목표(SWE PATCH resolution)로 전이되나?

**가장 날카로운 메타 공격.** 이 어딧 전체(round1~3)는 **SWT-bench Verified = 테스트 *재현* 점수**를 최적화한다. 우리 북극성은 **SWE-bench = 코드 *패치* resolution**이다. 둘은 다른 task다.

**전이가 약한 이유(어딧에 불리):**
- 어딧의 모든 정량(targets-gold +20.2pp, insertion p=1.0, assertion 비단조 53%)은 **"좋은 *테스트*를 짜는" 축**에서 측정됐다. 우리 갭(`jun-29-gap-essence`)은 "**맞는 파일 짚고 *edit* 수렴 실패**" — *fix synthesis* 축이다. round2 본인도 TASK1에서 (A)(C)(F)(G)를 전부 "repro *스타일*/repro *입력 품질*"로 분류하고 "**우리 진짜 병목은 fix를 잘 고르는 축**"이라 인정한다. 즉 **어딧이 측정한 5개 lever 중 4개는 우리 target task와 misaligned**임을 어딧이 자백한다.
- repro 품질이 fix resolution으로 전이되는 **유일 경로 = (H) surrogate-oracle**: 좋은 repro 테스트가 *fix를 거르는 오라클*이 될 때만 repro 품질이 patch 점수에 닿는다. 그 외 (A)(D)(E)(F)(G)는 repro 점수만 올리고 patch 점수엔 무관할 수 있다.

**전이가 그나마 사는 이유(어딧에 유리):**
- 우리 파이프라인은 repro 테스트를 *fix의 오라클*로 쓴다(acceptance/repro-vote, LANDED). 이 구조에선 **repro 품질 = 오라클 품질 = fix selection 품질**이라 전이가 성립. (C)가 (H)의 입력 게이트라는 round2 논리가 이 전이 경로다.
- 단 그 전이는 **(H)가 켜지고 효과가 있을 때만** 발생. (H) 미측정이면 전이 가설 자체가 미검증.

**판정**: **어딧은 우리 target에 대해 부분적으로만 옳은 proxy를 최적화한다.** SWT-bench repro 점수 직접 추격은 over-fit 위험이 실재한다 — repro 점수를 올리는 lever(A/D/E/F/G) 대부분이 patch 점수로 전이 안 될 수 있다. **유일 전이 통로는 (H)이고, 그래서 (H) 외 lever에 측정 예산을 쓰는 건 target-misaligned.** 이는 §0/§1의 "병목은 측정 rail"과 합쳐져 **"잴 거면 SWT repro 점수 말고 우리 SWE patch 슬라이스(synthesis-class fail 28 + competitor-gap top20)에서 (H) ON/OFF를 재라"**로 귀결. round2 TASK5 모집단 선택은 이걸 이미 옳게 골랐다(SWE-bench Verified 슬라이스) — 다만 채점기를 SWT grading.py로 쓰겠다는 부분이 §3의 6-run 비용을 숨겼다.

---

## 5. 최종 verdict — 이 어딧이 우리 계획에서 바꾸는 단 하나

**정직한 답: "이미 지은 걸 가서 측정하라." 새 lever는 없다.**

- (H) 오라클 루프·acceptance·grounding·bootstrap = **전부 LANDED·default-OFF·UNMEASURED**(메모리 5개 확증). 어딧이 ROI #1~#3으로 민 게 전부 이미 코드다. 어딧은 자기 결론이 이미 main에 있다는 걸 모른 채 "배선만 남음"이라 반복 — 그 배선조차 끝났다.
- 갭 진단("단일-pass false-green 수렴")·false-green 재발 경고 = `jun-29-gap-essence`·`jun-28-closure-repair-false-green`가 **선점**. 재발견이다.
- (C) change-coverage 게이트의 *출력측*(도달성 판정+reject seam)만 **반쪽 신규**, 그나마 (H) 종속이라 (H) 측정 후로 미뤄도 됨.

**이 어딧이 *진짜로* 바꾸는 단 하나** = **§3의 측정-rail 비용 정정.** round2가 "docker-free pure-python으로 싸게 잰다"고 깐 낙관은 **틀렸다**: swt grading은 인스턴스당 **gold 코드패치 적용 + base/gold 양 트리에서 후보 테스트 재실행(최소 2~4회, 정식 6회)**을 요구하고, pure-python인 건 마지막 산술뿐이다. 즉 어딧의 순효과는 "**새 lever 발견**"이 아니라 "**측정이 생각보다 싸지 않다, 그러나 docker는 안 써도 된다**"는 비용 재책정. 이건 actionable하다 — 우리 `execute.ts`가 *patched tree*만 도는 현 상태에 **base-commit pre-run + f2p 차분 + swt 포맷 export** 부품을 더해야 측정 rail이 선다는 구체 작업을 지목한다.

**그래서 plan 변경 = 딱 두 줄:**
1. **새 lever 짓지 마라.** (H)/(C)/(G)는 이미 있다. 측정 예산을 (A)insertion/(D)multi-test/(E)flip에 쓰지 마라(어딧이 NULL/misaligned로 확증한 negative 가이드 — 이게 어딧의 실질 가치).
2. **측정 rail부터 정직하게 세워라.** docker-free는 맞지만 execution-free는 거짓. per-instance base+gold 2-트리 재실행 파이프라인(`execute.ts` 확장)을 만들고, **SWT repro 점수가 아니라 우리 SWE patch 슬라이스에서 (H) ON/OFF 2×2**를 serial 채점으로 재라(`jun-19` false-neg·`jun-29` env-era confound 주의). 그게 전부다.

---

## 10줄 요약 (decision-input)

1. **ACTUALLY 바꾸는 것 = 거의 없음.** (H)오라클루프·(C)grounding·(G)bootstrap·acceptance는 **전부 LANDED·default-OFF·UNMEASURED**(메모리 5개). 어딧은 *이미 지은 걸* "배선만 남음"이라 재발견했다.
2. **"nothing new" survives.** ROI #1·#3과 갭 진단은 `jun-28-reprovote`/`jun-28-oracle-first`/`jun-29-grounding`/`jun-29-gap-essence`/`jun-28-closure-repair`가 선점. 병목은 새 lever가 아니라 **측정 rail**.
3. 어딧의 *유일 positive 가치* = 경쟁사 데이터로 (A)insertion p=1.0·(D)multi 1.47동일을 NULL 확증 → **측정 예산을 거기 쓰지 말라는 negative 가이드.**
4. **(C) localization-gate = 반쪽만 신규.** 입력측(extractSignatures grounding) LANDED, **출력측(change-coverage selection 게이트 + 호출그래프 도달성 판정 + reject seam) 진짜 미보유.** 단 (H) 종속이라 후순위.
5. **측정-rail "docker-free pure-python" 주장 = 부분 거짓.** `get_resolution_success`만 순수함수, 그 입력은 인스턴스당 **gold 코드패치 적용 + base/gold 양 트리 후보-테스트 재실행 2~6회**(run_evaluation.py:178-180)를 요구.
6. coverage-free·docker-free는 참, **execution-free는 거짓.** "stdout만 뽑으면" = adapter 1개로 안 끝남. base-commit pre-run + f2p 차분 파이프라인이 전제.
7. **over-fit 위험 실재.** 어딧은 SWT *repro* 점수 최적화, 우리 target은 SWE *patch* resolution. round2 자백대로 5 lever 중 4개(A/D/E/F/G)는 patch로 전이 안 될 수 있다.
8. **유일 전이 통로 = (H).** repro 품질이 *fix 오라클*일 때만 patch 점수에 닿음. (H) 외 lever에 예산 쓰는 건 target-misaligned.
9. **plan 변경 = 두 줄:** ① 새 lever 짓지 말고 NULL(A/D/E)에 측정 안 쓰기, ② 측정 rail부터(base+gold 2-트리 재실행, `execute.ts` 확장), **SWT 점수 말고 우리 synthesis-class fail 28 + competitor top20 슬라이스에서 (H) 2×2 serial A/B.**
10. **결론(가장 정직하게): "Just go measure what we already built."** 어딧이 바꾸는 진짜 한 가지는 그 측정이 docker는 안 들지만 *공짜도 아니라는*(6-run) 비용 정정뿐.
