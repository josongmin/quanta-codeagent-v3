# Round-4 TRANSFER ADVERSARY — "OpenHands가 reproduce를 자율로 처리한다"가 우리(quanta) plan에 실제로 쓸모있나

> 작성일 2026-07-01. 5-라운드 적대 어딧의 **Round-4 (transfer/actionable to us)**.
> 입력: `openhands-loop/04-reproduce-flow.md`, `openhands-loop/02-step-trigger.md`,
> 우리 어딧 수렴결론 `audit/round3-synthesis.md` + `audit/round3-final-adversary.md`,
> 그리고 우리 코드/메모리(`localize-phase-guard.ts`·`exploration-ladder.ts`·`repro-doubt-guard.ts`·`gate-decision.ts`;
> `agent-loop-4way-comparison`·`jun-27-11141`·`jun-29-gap-essence`·`jun-28-reprovote`·`jun-29-grounding`).
> 공격 대상 = transfer 주장: **"초상위권(OpenHands)은 reproduce를 강제 파이프라인 없이 모델 자율+워크플로 프롬프트로 처리한다. 우리는 harness-강제 철학이라 재검토 대상이다."**
> 임무: 이 actionable 주장을 적대적으로 깨라 — 실제로 쓸모있나, 아니면 흥미롭지만 적용 불가인가.

---

## 0. 한 줄 — 이 transfer 주장이 우리한테 무엇을 주나

**거의 아무것도 안 준다. "재검토 대상"이라는 함의가 틀렸다.** OpenHands가 reproduce를 코드-강제 없이 처리한다는 *관찰*은 04-reproduce-flow §4 grep으로 **정확하고 입증됨**(repro 엔진 0건, phase 분기 0건). 그러나 거기서 "그러니 우리도 harness-강제를 풀어 자율로 가라"는 *prescription*은 **인과 비약**이다 — (a) OpenHands의 자율 성공은 model 강도의 산물인데 우리 어딧이 model을 지배인자로 이미 못 박았고(round3 §3, 12.8pp same-model), (b) 우리 메모리(jun-27-11141)는 **강제가 약한 모델을 보정한 직접 반례**를 보유하며, (c) 이 OpenHands 분석은 *patch-loop 일반론*이지 우리가 흡수하려던 *repro-test 품질* 타겟과 misaligned다. 결론: 이 분석은 **"우리 harness-강제 철학을 흔드는 증거가 아니라, 오히려 강화하는 null-result"**다. plan은 round3 결론(측정 rail부터) 그대로 — 단 §5에서 추출한 **싼 prompt-rider 1~2개만** cheap add.

---

## 1. 공격축 1 — "자율이 낫다"가 우리한테 인과인가? (model confound로 깨기)

transfer 주장의 숨은 전제: "OpenHands가 reproduce를 자율로 처리하고 SWE 리더보드 상위 → 자율이 강제보다 낫다." 이걸 친다.

**(1-a) OpenHands의 자율 성공은 model이 캐리한다 — 우리 어딧이 이미 측정.**
round3-synthesis §3 (2)가 박은 단일 숫자: **같은 gpt-5-mini, 같은 new-file 스타일인데 ReProAgent 70.3% vs OpenHands 57.5% = 12.8pp** scaffold 효과. 그리고 repo가 ~40-70pp 스윙. 즉 OpenHands가 "자율로도 잘한다"고 보이는 건 **강한 model + scaffold 조합**의 산물이지 "자율 그 자체"의 인과 기여가 아니다. 04-reproduce-flow §0가 (d) 모델 자율 비중을 ~35%로 매긴 것도 같은 방향 — 자율은 *책임을 떠안는 잔여(residual)*이지 *성능을 만드는 lever*가 아니다. 04-reproduce-flow는 "OpenHands가 자율로 **잘한다**"고 주장한 적이 없다; "자율로 **결정한다**"고만 했다. transfer 주장이 그 사이에 "잘한다"를 몰래 끼웠다.

**(1-b) 직접 반례 — 우리한텐 강제가 약한 모델을 PASS시켰다 (jun-27-11141).**
메모리 `jun-27-11141-model-gap-controlled`: django-11141에서 plain config면 gpt-5.4가 777B naive trap에 빠져 P2P1/24 fail. **그러나 `QUANTA_BENCH_MUST_PASS=sticky`(강제 sticky-red)를 켜면 5.4도 1334B로 재합성해 PASS**(P2P0/24, turns 43). 이건 "강제가 약한 모델의 수렴 실패를 보정한다"는 **측정된 인과**다. 자율로 풀면 5.4는 trap에 정지했다 — 강제가 정지를 깬 것. 즉 model이 천장에 못 미칠 때 **harness-강제가 net-positive**라는 우리 자신의 증거가 있다. transfer 주장은 이 반례를 무시한다.

**(1-c) 그럼 강제가 항상 옳은가? — 아니다, 그래서 이게 흥미롭다 (정직).**
강제의 위험은 우리도 데였다: `jun-22-scaff-northstar-3`의 `*_STEER` answer-key 하드코딩(=과적합 강제), `jun-21-strict-lsp-gate`의 astropy 하드킬(=잘못된 게이트가 turns=0). 즉 **강제는 "옳은 게이트일 때만" net-positive**고, 틀린 게이트는 자율보다 나쁘다. 그러나 이건 "자율로 가라"가 아니라 "**게이트를 옳게 만들고 default-OFF로 측정하라**"를 함의한다 — 정확히 우리가 이미 하는 것. **인과 판정: 자율↔강제 축은 model-confounded라 OpenHands 사례로 우리 방향을 못 바꾼다. 우리 쪽엔 강제-net-positive 직접 측정이 있고(11141), OpenHands 쪽엔 자율-net-positive 측정이 없다(model confound).**

---

## 2. 공격축 2 — 자율의 전제(강한 모델+런타임)를 우리가 충족하나

**자율은 공짜가 아니라 "강한 model + 16-tool 런타임"이라는 *전제* 위에서만 작동한다.** 02-step-trigger가 입증: OpenHands step 루프는 phase를 모르고(§7), 매 step **전체 tool 셋을 전부 노출**(agent.py:596)하고, observation을 append-only history로 통째 재주입(§4.2)한다. 자율이 성립하려면 (i) 매 step 올바른 tool을 고를 강한 model, (ii) 그 tool들이 실제 존재하는 런타임(terminal/file_editor/finish + bash 실행환경), (iii) 무제한 반복(max_iter 기본 500)이 전제다.

**우리 bench 하네스가 이 전제를 충족하나? — 부분적으로만.**
- (i) model: 우리는 OpenAI key 고정(gpt-5.x). 자율 전제의 "강한 model"은 우리 손 밖. round3 §3가 model을 지배인자로 못 박은 그 이유.
- (ii) 런타임: 우리도 tool 런타임은 보유(quanta는 multi-surface, bench는 terminal/edit/search 등). 그러나 우리 철학은 *full-autonomy 런타임*이 아니라 *gated 런타임* — `localize-phase-guard.ts`가 Phase 1 동안 **mutating tool을 실제로 BLOCK**한다(코드 확인: line 142 "edits are blocked until you have identified the exact file and function"). OpenHands엔 이런 게이트가 0(02 §7.3 "이 시점엔 이 tool만 허용 같은 게이팅이 없다").
- (iii) 반복: OpenHands 500-iter 자율 vs 우리 single-pass-ish + bounded repair. 우리가 자율을 흉내내려면 **무제한 반복 비용**(round3 §3의 model+budget 지배)을 떠안아야 한다.

**판정: 자율을 흉내내려면 "게이트를 떼고(=localize-phase-guard OFF) + 반복 예산을 키우고 + model이 강하길 빈다"가 된다. 앞 두 개는 우리가 통제하지만 net-positive 보장이 없고(오히려 11141 반례는 게이트 ON이 이김), 셋째는 통제 불가.** 즉 자율의 전제는 우리에게 **불리하게** 정렬돼 있다 — 우리가 못 바꾸는 model에 성능을 위임하라는 것. 이건 transfer가 아니라 **dependency 떠넘기기**다.

---

## 3. 공격축 3 — transfer 타겟 오정렬 (repro-test 품질 ≠ patch-loop 자율)

**가장 결정적.** 우리가 OpenHands에서 흡수하려던 건 *repro test 품질*(어떻게 좋은 재현 테스트를 짜나)이었다. 그런데 04-reproduce-flow가 실제로 밝힌 건 **OpenHands에 repro-test 생성 메커니즘이 *아예 없다*는 부재 증명**이다(§4 grep: fail_to_pass 0건, N-sampling 0건, majority-vote 0건). OpenHands의 "reproduce"는 few-shot Flask 예시(§3-1)에서 보듯 **build-run-debug 디버그 루프**(깨지면 로그 보고 고침)이지, *fail-to-pass 재현 테스트 작성*이 아니다. 게다가 그 few-shot조차 native-FC 모델엔 미주입(§3-2, fn_call_converter.py:398).

**그래서 타겟이 두 겹으로 어긋난다:**
1. **task 어긋남**: OpenHands가 자율로 하는 건 *patch 풀이* 루프다. 우리가 흡수하려던 건 *repro test 품질* 산출. round3-final §4가 이미 같은 메타 공격을 했다 — SWT-bench *repro* 점수 lever 5개 중 4개(insertion/multi/flip/bootstrap)는 SWE *patch* resolution으로 전이 안 될 수 있다. OpenHands 분석은 그 patch-loop 쪽이라, **repro-test 품질 흡수원으로는 빈 우물**이다(거기 repro 엔진이 없으니 가져올 repro 기법이 없다).
2. **방향 어긋남**: OpenHands는 repro 산출물을 "확인 후 삭제할 임시 진단물"로 격하(04 §2, FILE_SYSTEM `:28`/`:31`). 우리 파이프라인은 정반대 — repro 테스트를 **fix의 오라클로 되먹인다**(acceptance/repro-vote LANDED, `jun-28-reprovote`). 즉 우리 핵심 가치(repro=oracle)를 OpenHands는 *버린다*. OpenHands에서 "오라클 루프"를 흡수할 수 없다 — 거기 없으니까. 오히려 round3 §2 (S3)가 못 박았듯 그 오라클 루프가 **우리 차별점**이고 경쟁사(L*Agent multi-attempt) 대비 우리가 *지향하는* 방향이다.

**판정: transfer 타겟 오정렬. 이 OpenHands 분석은 우리 repro/oracle 작업에 *닿지 않는다*.** 그것은 "patch-loop은 자율로도 굴러간다"는 일반론일 뿐이고, 우리가 풀려던 "repro-test가 맞는 코드경로를 치게 만들기"(round3 (C)/(S1))나 "틀린 fix를 reject하는 오라클 루프"(round3 (H)/(S3))엔 *부재로 인해* 기여 0. **OpenHands는 우리가 이미 가진 것(오라클 루프)을 안 가졌고, 우리가 없는 것(자율 patch-loop)을 가졌는데 그건 model-confounded라 흡수가치가 낮다.**

---

## 4. 공격축 4 — 그럼에도 코드에서 가져올 구체물 (actionable 추출, 정직하게)

부재 증명에도 불구하고 OpenHands *프롬프트*에서 우리 system prompt로 옮길 싼 구체물이 있나. 각각 (i)이미 있음 / (ii)싸게 추가 / (iii)무의미로 분류.

| OpenHands 구체물 (file:line) | 우리 대응물 | 분류 | 근거 |
|---|---|---|---|
| **PROBLEM_SOLVING_WORKFLOW** EXPLORATION→ANALYSIS→TESTING→IMPL→VERIFY (system_prompt.j2:60-75) | `prompt-body.ts` 분석 ladder + `exploration-ladder.ts`(file_tree_summary→glob→ls→read) + `localize-phase-guard`(Phase1 강제) | **(i) 이미 있음 — 게다가 더 강함** | 우리는 워크플로를 *프롬프트 산문*이 아니라 *코드 게이트*로 강제. OpenHands는 soft-nudge(04 §1-1 "MUST 부재"), 우리는 hard-block(localize-phase-guard:142). 흡수할 게 없고, 우리가 *위*다. |
| **"create tests to verify issues BEFORE implementing fixes"** (system_prompt.j2:64) | `repro-doubt-guard.ts` + repro-test 파이프라인 + `verify-select-repro` knob | **(i) 이미 있음** | "fix 전에 재현 테스트"는 우리 repro-gen이 1급 단계로 보유. OpenHands는 비강제 nudge(04 §1-1 환경 조건부 출구 `:68-69`). |
| **FILE_SYSTEM single-file 지침** "use a single file rather than creating multiple versions" (system_prompt.j2:31) + "temp file이면 확인 후 삭제"(:28) | 우리 new-file 정책(round3 §1 D1: insertion vs new-file **p=1.0 null**) | **(iii) 무의미** | round3가 insertion/new-file 축을 NULL로 강등(Fisher p=1.0). single-file vs multi-file은 *위생*이지 점수 lever 아님. OpenHands가 이걸 NEVER로 강제하든 말든 우리 점수에 인과 없음. 흡수 무의미. |
| **finish-gate** (FinishTool→FINISHED, agent.py:281) | 우리 종료/no-patch-breaker(`no-patch-breaker.ts`)·budget·max-turn | **(i) 이미 있음** | model-driven 종료(finish tool 또는 content-only)는 보편 패턴. 우리도 종료 게이트 보유. 신규성 0. |
| **content-only=턴종료** 신호 (response_dispatch.py:294) | 우리 loop 종료 조건 | **(i) 이미 있음** | 동일 보편 패턴. |
| **corrective nudge on EMPTY/REASONING** (response_dispatch.py:316) | `jun-26` empty-stream circuit breaker (QUANTA_LLM_EMPTY_STREAM_BREAKER_K) | **(i) 이미 있음 — 우리가 더 정교** | OpenHands는 무한 nudge, 우리는 K-회 breaker로 continuation-loop 차단(메모리). 우리가 위. |
| **task_tracker "ESSENTIAL/unacceptable"** (system_prompt_long_horizon.j2) | 우리 focus-chain/plan-bridge(`jun-27-focuschain`) | **(i) 이미 있음** | long-horizon 태스크 추적은 plan-bridge로 보유. |
| **TECHNICAL_PHILOSOPHY** Linus 5-layer(taste/never-break-userspace) (system_prompt_tech_philosophy.j2) | — | **(ii) 싸게 추가 가능, but repro와 무관** | 04 §5가 "repro/test와 무관한 설계 리뷰 프레임워크"라 명시. system prompt에 한 블록 넣는 건 싸지만 *repro/synthesis 갭*과 misaligned → measure-first 원칙상 지금은 보류. |

**actionable 순효과: 거의 0.** OpenHands 프롬프트의 워크플로/finish/nudge/single-file은 전부 (i)이미 있음(대개 우리가 *코드 게이트*라 더 강함) 또는 (iii)무의미(insertion-null). 유일하게 (ii) "싸게 추가 가능"은 TECHNICAL_PHILOSOPHY 산문 한 블록인데, 이건 repro 타겟과 무관해 measure-first 게이트에 걸린다. **즉 흡수할 구체물이 사실상 없다 — 우리가 이미 OpenHands의 prompt-soft 버전을 *code-hard*로 보유하기 때문.**

---

## 5. 공격축 5 — 최종 판정: 이 5바퀴 어딧 전체가 우리 plan을 바꾸나

**바꾸지 않는다. round3 결론("이미 지은 걸 측정 rail부터")이 그대로 산다 — 오히려 강화된다.**

이 OpenHands transfer 분석의 순기여를 정직하게 결산:

1. **자율↔강제 축**: model-confounded라 OpenHands 사례가 우리 방향을 못 바꾼다(§1). 우리 쪽엔 강제-net-positive 직접 측정(11141)이 있고 OpenHands 쪽엔 자율-net-positive 측정이 없다. **harness-강제 철학은 "재검토 대상"이 아니라 우리 측정으로 *지지된* 선택이다.** transfer 주장의 함의가 틀렸다.
2. **자율 전제**: 우리에게 불리하게 정렬(못 바꾸는 model에 위임)(§2). 흉내내려면 게이트 떼고 예산 키우는데 net-positive 보장 0.
3. **타겟 오정렬**: OpenHands엔 repro-test 엔진이 *부재*라 흡수원으로 빈 우물; 우리 차별점(repro=oracle)을 OpenHands는 오히려 버린다(§3). 이 분석은 우리 repro/oracle 작업에 닿지 않는다.
4. **actionable**: 프롬프트 구체물 전부 (i)이미 있음(우리가 code-hard라 더 강함) / (iii)무의미(insertion-null) / (ii)1개만 싸게-가능하나 repro-misaligned(§4). 순추출 ≈ 0.
5. **메타**: 이 transfer 어딧이 round3-final §5의 "새 lever 짓지 말고 이미 지은 걸 측정하라"를 **반증하지 못하고 보강한다** — OpenHands는 우리가 안 가진 새 repro lever를 *주지 못한다*(부재). 따라서 병목은 여전히 **측정 rail**(round3-final §3의 base+gold 2-tree 재실행 비용 정정)이지 "자율로 전환"이 아니다.

**유일하게 살려둘 가치(정직)**: OpenHands가 reproduce를 *비강제*로 두고도 patch-loop이 굴러간다는 관찰은, 우리 강제 게이트가 *틀렸을 때*(jun-21 astropy 하드킬, jun-22 answer-key STEER) 자율이 fallback으로 더 안전할 수 있다는 **에지케이스 경고**로만 유효하다 — 그러나 이건 "강제를 버려라"가 아니라 "게이트를 옳게·default-OFF·measure-first로 유지하라"는 *우리가 이미 하는* 원칙의 재확인이다.

---

## 10줄 요약 (이 어딧이 우리 plan을 바꾸나)

1. **바꾸지 않는다.** transfer 주장("OpenHands 자율 = 우리 harness-강제 재검토 대상")의 *관찰*(repro 엔진 0, phase 분기 0)은 옳으나 *prescription*(자율로 가라)은 인과 비약. plan은 round3 결론(측정 rail부터) 그대로.
2. **자율↔강제는 model-confounded.** OpenHands 자율 성공은 강한 model 산물(round3: same-model 12.8pp scaffold·repo 40-70pp 지배). "자율이 낫다"는 측정 안 된 주장.
3. **직접 반례 보유**: jun-27-11141 — sticky-red(강제)가 gpt-5.4를 trap에서 PASS시킴. 우리한텐 *강제가 약한 모델을 보정*한 측정 인과가 있다. OpenHands 쪽엔 자율-net-positive 측정 없음.
4. **자율 전제가 우리에게 불리**: 강한 model + 무게이트 런타임 + 무제한 반복(500-iter) 전제. 흉내내려면 localize-phase-guard 떼고 예산 키우는데, 우리가 못 바꾸는 model에 성능 위임 = dependency 떠넘기기.
5. **타겟 오정렬(결정타)**: 우리가 흡수하려던 건 *repro-test 품질*, OpenHands가 자율로 하는 건 *patch-loop*. 게다가 OpenHands엔 repro-test 엔진 *부재*(04 §4 grep)라 흡수원으로 빈 우물.
6. **방향 정반대**: OpenHands는 repro를 "확인 후 삭제할 임시물"로 격하(FILE_SYSTEM :28/:31), 우리는 repro=fix-오라클(acceptance/repro-vote LANDED). 우리 차별점을 OpenHands는 버린다 — 흡수 불가.
7. **actionable 추출 ≈ 0**: 워크플로/finish/nudge/single-file 전부 (i)이미 있음(우리가 *code-hard* 게이트라 OpenHands soft-nudge보다 강함: localize-phase-guard가 실제 BLOCK) 또는 (iii)무의미(insertion p=1.0 null). single-file 지침은 round3가 NULL로 죽인 축.
8. **유일 (ii) 싸게-가능** = TECHNICAL_PHILOSOPHY 산문 한 블록, 그러나 repro/synthesis 갭과 misaligned → measure-first 게이트에 걸려 지금은 보류.
9. **메타 정렬**: 이 transfer 어딧은 round3-final의 "새 lever 짓지 말고 측정 rail부터"를 *반증 못 하고 보강*. OpenHands는 우리가 없는 새 repro lever를 부재로 인해 *주지 못한다*.
10. **정직한 결론**: harness-강제 철학은 "재검토 대상"이 아니라 *우리 측정으로 지지된* 선택. 흥미롭지만 적용 불가 — 단, 게이트가 *틀렸을 때* 자율이 안전 fallback이라는 에지 경고로만 유효(=게이트를 옳게·default-OFF·measure-first로 유지하라는 우리 기존 원칙 재확인). plan 변경 0줄.
</content>
</invoke>
