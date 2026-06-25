# Agent error & trial journal

진행 철학(2026-06-25 확정): **미니멀-퍼스트.** 루프는 LLM 신뢰(프론티어 동급), deterministic knob은 **확실히 측정된 것만** 넣는다. 안 풀리는 문제가 나오면 그때 **problem-driven**으로 knob 추가해 그 문제만 해결한다. 애매한 hard-veto는 닫는다(소프트/off).

---

## 2026-06-25 22:37 KST — ReAct 루프 vs 프론티어 과결정론 어딧 + "구현틀림 vs 불필요" 판정

**계기**: 프론티어(공식보드 79.2 mini-swe / vendor 보고 80~88%+) 대비 우리 측정이 70 미만. 이번 세션 측정 4회 전부 인프라가 먹음(python-not-found / env-deadline hang / box-loss / disk 99%). 그래서 "우리가 LLM 불신하고 deterministic 깝쳐서 헛짓하나"를 어딧(5에이전트, REPORT-jun25-react-loop-vs-frontier.md).

**핵심 발견**: 우리 ReAct **루프 자체는 프론티어와 동급으로 깨끗**(turn-loop veto 0, git diff=제출). 모든 헛짓 결정론은 **verify-select bench 컨트롤플레인에만** 존재. 거기서 "모델이 자기 답 정함"을 "harness가 9개 hard-gate로 재판정·거부·null"로 바꿈 → flaky self-oracle(repro 생성 45% 실패)+비실행 휴리스틱이 **정답을 죽여 빈패치로 세탁**(11138 산증거: gold-approach 6세션 편집 → winner=null → empty → completed_unresolved).

**게이트별 판정 (구현틀림 = 고치면 됨 / 불필요 = 빼야 됨):**

| 게이트 | file:line | 판정 | 닫는 법 |
|---|---|---|---|
| **#1 empty-laundering** `winner ?? fallback ?? ""` | driver.ts:3761 | **구현틀림** — 빈패치로 degrade가 잘못. fix가 이미 default-OFF knob으로 존재(`nonEmptyFallback`, best 후보로 degrade) | `QUANTA_BENCH_NONEMPTY_FALLBACK=1` 켜기 (코드 신규 X). default-ON 승격 후보 |
| **#2 proof-required hard-gate** | selection-gates.ts:184 | **불필요(하드로는)** — flaky repro 오라클이면 전 후보 veto→empty terminator. proof 신호는 ranking으로만 유효 | knob `verify-select-proof-required` 빼기(absorb preset이 이미 뺌) |
| **#4 MWE candidate_red veto** | selection-gates.ts:171 | **의존성 구현틀림** — veto 로직은 정당하나 의존하는 repro 오라클이 45% FN. 오라클 고쳐지기 전엔 하드 veto 부적격 | clean-mode 소프트(ranking credit)로 강등 |
| **#6 declaredExpected prose-regex** | selection-gates.ts:242 | **불필요 + answer-key 클래스** — 비실행 휴리스틱이 답 veto. no-answer-key 규칙 위반 소지 | research-mode 제거, clean=credit-only 유지 |
| **#3 familyCoverage veto** | selection-executor.ts:263 | **불필요(측정완료)** — producer-only 정답을 콜그래프 증거만으로 거부, NET-NEGATIVE 측정→이미 default-OFF revert됨 | 그대로 OFF 유지 |

**유지(good-determinism, 프론티어도 함, 손대지 마)**: turn-loop 전체(transcript sealing/budget/compaction/refusal-recovery — patch 안 건드림), no-patch-breaker **nudge**(advisory), cha-multisite/closure **순수 프롬프트 컨텍스트**, primary-rail RED-finish(존재+RED일 때만, TRAE보다 강함, false-green 봉인), sourceOnlyDiff(합의된 측정무결성).

**결정(닫아놔)**: 애매한 hard-veto는 **config로 닫는다** — 가는 길 preset = absorb 계열(proof-required 제거=#2, clean mode=#4/#6 소프트, familyCoverage OFF=#3) + `QUANTA_BENCH_NONEMPTY_FALLBACK=1`(=#1 fix). 코드 삭제는 보류(측정으로 net-neg 확인 후). 즉 "정답을 거부/null/세탁하는 veto"만 닫고, 측정무결성 게이트는 유지.

**ROI 순**: #1 nonempty-fallback(P0, 11138 클래스 즉시 회복) > #2 proof soft(이미 absorb) > #6 declaredExpected 제거.

---

## 2026-06-26 — verify-select OFF (single-pass 전환), 실측 입증

**계기**: frozen-3 로컬 A/B(verify-select 5 vs single-pass). **single-pass가 압승:**

| 케이스 | verify-select=5 | single-pass | gold 커버 |
|---|---|---|---|
| 13033 | **0B 빈패치**(후보 5개 다 core.py 편집했는데 게이트가 전부 reject→winner null) | 1445B non-empty | 1/1 |
| 11138 | 0/1 빈패치 | 6168B, **3/4 사이트**(sqlite 커버!) | oracle만 빠짐 |
| 14315 | 514B, base만 | 1275B, **2/2 dual-site 완성**(base+postgresql 둘 다) | 완성 |

→ verify-select = "best-of-N 5개 생성 → 결정론 9게이트로 검증 → winner 선택, 다 떨어지면 빈패치". flaky repro 오라클(45% FN)+엄격 게이트가 **정답 후보를 죽여 빈패치로 세탁**. 끄니까 모델이 그냥 git diff 제출 → 빈패치 사라지고 dual-site 완성.

**결정: verify-select OFF.** frozen preset은 in-place 편집 금지(hellgate)라 **going-forward 런 config로 끈다**(single-pass = verify-select 미설정):
```
QUANTA_BENCH_PRESET=agentless-v1 \
QUANTA_BENCH_FORWARD_LOCALIZE=1 QUANTA_BENCH_SPEC_FIDELITY_INVARIANT=1 \
QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER=1 QUANTA_BENCH_CHA_MULTISITE_STEER=1 \
QUANTA_BENCH_NONEMPTY_FALLBACK=1 QUANTA_BENCH_CONCURRENCY=3
```
= 미니멀 single-pass(mini-swe 79.2 posture) + 흡수레버 env. **followup**: 흡수 preset을 single-pass 버전으로 신규 추가(`agentless-v6-singlepass-absorb`)해서 frozen 동결 — SSOT(literal+ABSORB_MODULES+동치test) 동기 필요라 별도 작업. 지금은 env config로 충분.

주의: 로컬 "FAIL"은 docker 막힌 no-op grade(testCmd:true)라 진짜 resolved 아님 — 패치 커버리지가 신호. 진짜 resolved는 docker 호스트 채점 필요.

---

## 2026-06-26 00:05 KST — "heavy 모드를 항상 말고 LLM 판단으로 특정시점 트리거" = V5 adaptive 이미 빌드됨

**질문(USER)**: single-pass가 기본이어야 하지만 어려운 케이스엔 heavy(verify-select/완성도) 모드가 필요. 그걸 항상 켜지 말고 **LLM 판단하에 특정 시점에 트리거**할 수 없나?

**답: 이미 빌드돼 있다 — `src/runner/batch/eval/adaptive-escalation/` (jun-22 v5 Wave-3), default-OFF.**
- `llm-router.ts`(`makeLlmRouter`) = **LLM이 다음 phase(싸구려 thin vs 비싼 verify-select/repair/완성도)를 고르는 라우터.** evidence packet(`router-evidence.ts`) 보고 모델이 escalate 여부 결정.
- `adaptive-run.ts`: 라우터 출력→controller 검증→`escalate-needs-human`까지, **절대 silent submit 안 함. submit 권한은 에이전트.**
- `decision-legality.ts` 핵심 설계: *"derived guess가 모델의 phase 진입 판단을 override하면 안 됨"* = **모델 판단 우선, 휴리스틱 veto 금지** — 정확히 "LLM 판단하에 트리거".
- `PHASE_MODULES`/`derivePhasePosture`: 런타임에 선택된 phase의 capability(verify-select/proof/완성도)만 주입. 기본은 thin(single-pass).
- 스위치: `QUANTA_BENCH_V5_ADAPTIVE` (default-OFF). 켜면 thin-default→LLM-router escalate.

**왜 아직 OFF**: 라우터가 escalate 판단에 쓰는 **오라클(repro)이 45% FN**이라 라우팅 신호를 못 믿어서 동결(jun-22). 즉 brain은 있는데 senses(오라클)가 깨져 못 켠 상태.

**그래서 진행 방향(저 전략의 완성형)**: 
1. **thin single-pass = 기본 phase**(verify-select OFF, 위 2026-06-26 실측대로).
2. **V5 adaptive(`llm-router`) = escalate 트리거** — 모델이 "single-pass로 부족(multi-site 미완/메시지 불확실)" 판단 시에만 heavy phase 진입. heavy 게이트는 항상-veto가 아니라 **on-demand 도구**가 됨(= "닫아놔 + 문제시 problem-driven"의 런타임 자동화).
3. **선결조건**: escalate 신호로 쓰는 오라클 신뢰도(repro FN) 개선 — 안 그러면 라우터가 헛 escalate. 이게 V5 켜기 전 P0.

요지: 새로 만들 게 아니라 **(a) single-pass 기본화 + (b) V5 adaptive 라우터를 escalate-only로 켜기 + (c) 오라클 신뢰도 확보** 3단계. heavy는 "항상"이 아니라 "LLM이 부르면".

---

## 2026-06-26 02:08 KST — 원격 mini/live 베이스라인 실측 + 간소화 계획

**원격 EC2 박스(on-demand, 우리 AMI)에서 mini-swe·live-swe + gpt-5.5 frozen-3 실측** (랩탑은 proxy만, 박스가 docker agent+official harness 채점, reverse-tunnel로 모델). 인프라 완주:

| 케이스 | mini+5.5 | live+5.5 | 우리 |
|---|---|---|---|
| django-11138 | ✅ resolved | ✅ resolved | ❌ (verify-select 0/3; single-pass 3/4 ungraded) |
| django-14315 | ❌ | ❌ | ❌ |
| astropy-13033 | ❌ | ❌ | ❌ |

→ **결정적 분리**: (1) **11138 = 우리 scaffold 문제** — 같은 gpt-5.5로 미니멀이 풀고 우리 heavy가 못 풂. (2) **14315/13033 = gpt-5.5 천장** — 프론티어 미니멀도 못 풂(14315는 dual-site 커버해도 시맨틱 못맞춤). mini≡live(self-evolve 효과 0).

### 간소화 계획 (mini-swe ≈ 우리 목표 posture)

**P1 — single-pass 기본화** (최우선, 11138 회복):
- 기본 bench posture = single-pass(verify-select OFF). 우리 turn-loop은 이미 프론티어 동급 clean(veto 0). mini가 이 posture로 11138 품 = 우리도 됨.
- 신규 `agentless-v6-minimal` preset = agentless-v1 코어(lsp/localize-phase/issue-hint/repo-map/read-outline/repro-test/test-runner/retry-transient) only. verify-select·proof-required·family-coverage·MWE-veto·declaredExpected **전부 미포함**.

**P2 — 애매한 hard-veto 닫기** (audit 5종, config로): proof-required·MWE candidate_red·declaredExpected·familyCoverage = 미니멀 preset서 제외. 코드 삭제는 보류(net-neg 측정 후). empty-laundering은 nonempty-fallback(default-ON 후보)로 대체.

**P3 — good-determinism 유지** (mini도 함): turn-loop integrity(transcript/budget/compaction/refusal), primary-rail RED-finish, sourceOnlyDiff. patch 안 건드림 = 유지.

**P4 — escalation은 V5 adaptive(LLM-router)로 on-demand**: single-pass 부족 판단 시에만 heavy phase. 선결=repro 오라클 FN 개선(라우터 신뢰 신호). 그 전엔 단순 single-pass.

**P5 — 문제별 knob은 problem-driven**: 측정된 실패 + A/B win + default-OFF일 때만 추가. 14315/13033은 gpt-5.5 천장이라 scaffold knob 대상 아님 → **모델 업그레이드**(Opus 4.8/GPT-5.3 Codex) 영역.

**측정**: 모든 변경은 frozen-slice A/B를 **원격 박스**(이번에 검증된 EC2 mini-path 재사용 — provision→run→docker grade→terminate, 랩탑 free)로. 로컬 docker no-op grade는 신뢰 못 함.

ROI순: P1(single-pass 기본 → 11138 회복) > P2(애매veto 닫기) > P4(escalation, repro오라클 후) > 모델업그레이드(14315/13033).

---

## 2026-06-26 02:49 KST — ✅ 간소화 실측 성공: 11138 RESOLVED (thesis 입증 완료)

**우리 minimal scaffold가 원격 박스 진짜 채점에서 11138 풀었다.** config = `agentless-v1`(single-pass, verify-select 없음) + `QUANTA_BENCH_IN_LOOP_EXEC=full`(execfull) + `QUANTA_BENCH_NONEMPTY_FALLBACK=1`, gpt-5.5, full-remote on-demand, fresh chatgpt.json.

| | 11138 | 14315 | 13033 | 합 |
|---|---|---|---|---|
| 우리 verify-select(heavy) | ❌ | ❌ | ❌ | 0/3 |
| mini-swe + gpt-5.5 | ✅ | ❌ | ❌ | 1/3 |
| **우리 minimal+execfull + gpt-5.5** | **✅** | ❌ | ❌ | **1/3 (=mini 동급)** |

11138 winning patch = gold 4파일 정확히 (mysql/oracle/sqlite3-base/sqlite3-operations), grade resolved=true, failToPass 0 fail, passToPass 73/73 (회귀 0).

**입증된 것:**
- 11138 = scaffold 문제였음(heavy verify-select 9게이트가 정답 죽임). **간소화(single-pass)로 회복.** 우리도 mini급.
- **execfull이 키** — plain single-pass는 3/4(sqlite3/base 누락), execfull(인루프 full test exec = TRAE 방법)이 런타임에러로 빠진 사이트 드러내 4/4 완성. cha-multisite veto 같은 결정론 강제 없이 **모델이 테스트 피드백으로 스스로 완성**.
- 14315/13033 = gpt-5.5 천장(mini도 우리도 못 풂) → 모델 업그레이드 영역, scaffold knob 아님.

**인프라 교훈 (측정 5회 confound 후 정리)**: box-loss→on-demand로 해결, python-not-found/disk→해결, **429=full-remote가 박스서 토큰 refresh 못 함(401)→stale→throttle. fix=토큰 fresh 유지 OR mini식 proxy(랩탑서 refresh) 차용.** 깨끗한 측정엔 fresh 토큰 필수.

**다음**: 이 winning config(`agentless-v1`+execfull+nonempty-fallback)를 frozen preset(`agentless-v6-singlepass-execfull`)로 동결 + 더 큰 슬라이스(our-only-misses 10+)에서 verify-select vs single-pass A/B로 일반화 검증. 14315/13033은 frontier 모델(Opus 4.8/GPT-5.3 Codex) 확보 시 재측정.
