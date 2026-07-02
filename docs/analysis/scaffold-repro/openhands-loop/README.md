# openhands-loop — OpenHands agent-sdk loop/reproduce 코드분석 + 5바퀴 적대 어딧 (인덱스)

분석 대상: `competitor-scaffolds/openhands-agent-sdk/` (OpenHands 오픈소스 SDK의 **default 코드 경로**).
질문: **"OpenHands는 그냥 프롬프트인가? reproduce(버그 재현)·탐색·생성·검증을 어느 시점에·무엇이 강제하는가?"**
방법: 5축 코드분석(01~05) → 4바퀴 적대 반증(round1~4) → 종합·메타 적대(round5). 모든 주장 file:line 핀.

---

## 폴더 구성

### 1차 코드분석 (01~05) — "무엇이 어떻게 동작하나"

| 문서 | 주제 | 핵심 판정 |
|---|---|---|
| `01-prompt-rendering.md` | system message 렌더 파이프라인 | 바디는 거의 정적 1장이나 파이프라인은 **동적 합성 빌더**(2엔진 Jinja↔registry·guard 9·변수 5소스·OS refine·static/dynamic 2블록 캐시). conv당 1회 freeze. |
| `02-step-trigger.md` | step/loop/LLM 발사 메커니즘 | step()=pending→blocked→condensation→LLM 1회→response 분기. **reproduce-first/phase 분기 0**; 종료=finish tool 또는 content-only(+guard: max_iter 500/budget/stuck). |
| `03-tools-dispatch.md` | tool 정의·dispatch 계층 | 능력(side-effect)은 100% tool schema/executor; tool description=mini-prompt(task_tracker 690단어). "그냥 프롬프트" 기각. *(R1/R2/R3가 일부 over-claim 정정 — 아래)* |
| `04-reproduce-flow.md` | reproduce 발생 메커니즘 | **repro 전용 엔진 부재**(grep 0건). repro=비강제 워크플로 산문 + few-shot(native-FC 미주입) + 모델 자율. 코드 강제 0%. |
| `05-context-management.md` | condenser/메모리/skill/AgentContext | 매 호출 context=정적 prompt+동적블록+tool schema+condense된 history+trigger skill의 **동적 합성물**(5 인프라 계층). |

### 적대 어딧 (round1~5) — "그 결론이 흔들리나"

| 라운드 | 공격 대상 | 무엇을 깼나 |
|---|---|---|
| `audit/round1-indirect-coercion.md` | "reproduce 0% 강제·순수 자율" | ★**critic finish-gate 실재**(default-OFF·repro 미검사) 발견 → "finish-gate 없음" over-claim 정정. terminal `:42`=오입력 교정기로 정정. few-shot native-FC 0 확정. |
| `audit/round2-locus-of-timing.md` | "tool 중심 100%" | **차원 혼동**: 행동=능력+순서권장+시점결정 3축. tool 100%는 *능력 축만*. 시점 결정자=**모델 추론**(prompt·tool은 입력). |
| `audit/round3-infra-redherring.md` | "복잡 인프라 5계층" | reproduce 한정 시 **5계층은 잉여(red herring)**. repro=15줄+2tool+자율로 환원. condenser=진입점 의존(bare OFF/팩토리 ON) 정정. |
| `audit/round4-transfer-to-us.md` | "우리 harness-강제 재검토 대상" | **transfer ≈0**: 자율↔강제 model-confounded, 우리 강제-net-positive 반례(11141), repro-test 흡수원 빈 우물, 방향 정반대(repro=oracle). plan 변경 0. |
| `audit/round5-synthesis.md` | **종합 + 메타 적대** | 정정 5건 원장화, 5바퀴 생존 명제 S1~S8 confidence 부여, 정확한 한 문장, ★메타 약점 "SDK ≠ 제출 config" 명시, plan 변경 0 확정. |

---

## 최종 결론 (round5 종합 — 5바퀴 생존)

**정확한 한 문장 (SDK default 경로 기준):**
> OpenHands는 reproduce·탐색·생성·검증을 위한 **전용 엔진이나 시점 hard-gate를 코드에 두지 않고**(critic 완료성-gate조차 default-OFF이며 reproduce를 검사하지 않는다), 비강제 워크플로 프롬프트 15줄로 "고치기 전 재현 테스트"를 *권하고* Terminal·FileEditor tool로 *능력만* 공급한 뒤, 실제 시점·순서 결정은 전적으로 **매-step 모델 추론에 위임**한다 — 일반 prompt-합성 인프라는 이 권고·능력을 *배달*하는 봉투일 뿐 reproduce를 *발생*시키지 않는다.

**5바퀴 생존 명제 (confidence):**
- **S1 (HIGH)** reproduce 전용 엔진 부재(N-sampling/majority-vote/dual-tree grep 0).
- **S2 (HIGH)** reproduce 시점 hard-gate 0 — critic조차 non-empty patch+finish만 보지 reproduce 미검사.
- **S3 (HIGH)** reproduce 행동 = 비강제 워크플로 15줄(`static.py:178-196`) + Terminal/FileEditor + 모델 자율.
- **S4 (HIGH)** 시점 결정자 = 매-step 모델 추론; prompt·tool은 입력.
- **S5 (HIGH)** "그냥 프롬프트"도 "복잡 5계층"도 부정확.
- **S6 (MED)** critic finish-gate(완료성)는 실재하나 default-OFF.
- **S7 (HIGH)** few-shot 시점 영향 native-FC에서 0.
- **S8 (MED)** transfer 가치 ≈0 — plan 불변(부재 증명으로 버팀).

**메타 최대 약점 (정직하게):** 우리가 본 건 **오픈소스 SDK의 default 코드 경로**뿐이다. 실제 SWT/SWE 리더보드 제출 config(All-Hands production이 critic, 특히 외부 API critic을 켜고 reproduce-검사를 넣었는지)는 **미입수**다. 결론은 "**SDK default 경로 한정**"으로 scope해야 정직 — 제품 일반화 시 unproven. 단 부재 증명들은 config로 *추가*될 뿐 현 경로에서 *현존 않음*은 불변이라 코어는 견딤.

**우리(quanta) plan 영향: 변경 0줄.** 측정 rail부터(round4 유지). OpenHands actionable ≈0(워크플로/finish/nudge는 우리가 *code-hard* 게이트로 이미 보유, single-file은 insertion-null). 유일 후속 ROI=제출 config 입수해 critic 켜짐 여부 *측정*(MED, 측정 rail보다 후순위). harness-강제는 "재검토 대상" 아니라 우리 측정으로 지지된 선택.
