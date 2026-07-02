# ReProAgent core 파이프라인 — 부품 인벤토리 (재조립 가능성 확정)

**질문**: ReProAgent 7단계(localize→root-cause→assertion-plan→test-gen→base-run→execution-review→repair)를
"새로 만들기"가 아니라 "기존 knob/코드 재조립"으로 세울 수 있나? 각 단계 대응물 + 상태를 file:line으로.

**방법**: knob 배선은 `schema(SSOT) → posture(knobs-bench.ts) → readSite(driver/*)` 3층으로 추적. schema 파일
(`src/config/knob-schema/schemas/*`)은 파생 SSOT이며 "not imported by live driver"(bench-repro.ts:16) — 실배선은
`runner/knobs/knobs/*` + `knobs-bench.ts` posture + driver readSite. "있음-배선"은 이 사슬이 driver readSite까지
닿았음을 확인한 것.

---

## 단계별 표 [단계 | 우리 knob/코드(file:line) | 상태 | 재조립방법]

### 1. localize
| 부품 | knob/코드(file:line) | 상태 |
|---|---|---|
| issue-hint (agentless/regex) | schema `bench-a.ts:117`; posture `knobs-bench.ts:636,689`; readSite `driver.ts` | 있음-배선 |
| issue-hint expected/actual | schema `bench-a.ts:144`; posture `knobs-bench.ts:637,691`; 추출 `src/agent/issue-hint/extract-expected-actual.ts` | 있음-배선 |
| forward-localize | schema `bench-b.ts:128`; posture `knobs-bench.ts:453,617`; readSite `driver.ts:154`(posture.forwardLocalize) + `forward-localize-trace.ts` | 있음-배선 |
| cha-multisite-steer / -general | schema `bench-b.ts:149,175`; posture `knobs-bench.ts:457,462,619,620`; `cha-multisite.ts` | 있음-배선 |
| LSP nav | preset param `lsp:"1"`(preset-specs.ts); readonly nav CLI-default-on | 있음-배선 |

**상태: 재조립 가능** (모든 로컬라이즈 레버가 배선됨).

### 2. root-cause / assertion-plan (fix되면 뭐가 맞나 먼저 고정)
| 부품 | knob/코드(file:line) | 상태 |
|---|---|---|
| verification-plan (typed VerificationPlan + successPredicates) | schema `bench-a.ts:220`; posture `knobs-bench.ts:386,602`; build `src/agent/verification-plan/build.ts` | 있음-배선 |
| primary-rail (planner-primary를 done-gate로) | schema `bench-a.ts:236`; posture `knobs-bench.ts:388,603` | 있음-배선 |
| declared-expected 추출 | `src/agent/verification-plan/extract-issue-declared-expected.ts:130` | 있음-배선 |
| declared-expected → predicate | `declared-expected-matcher.ts` (`resolveRepairEvaluatePredicate`); repair 배선 `driver/repair-phase.ts:18,316,445` | 있음-배선 (repair-spec-gate 게이트) |
| repair-spec-gate | posture `knobs-bench.ts:439,615` | 있음-배선 |

**상태: 재조립 가능.** "fix되면 뭐가 맞나"를 PUBLIC issue text에서 뽑아 typed predicate로 고정하는 경로가 존재하고
repair 루프에 배선됨. 단, extractIssueDeclaredExpected는 precision-first regex — issue가 expected를 명시 안 하면
undefined(fail-open), 즉 "항상 assertion-plan을 얻는" 보장은 없음(있으면 쓰고 없으면 무배선).

### 3. test-gen (repro 생성)
| 부품 | knob/코드(file:line) | 상태 |
|---|---|---|
| repro-test K-sample | schema `bench-repro.ts:37`; posture `knobs-bench.ts:253,692`; readSite `driver.ts` | 있음-배선 |
| repro-grounding (setup-skeleton splice) | schema `bench-repro.ts:97`; posture `knobs-bench.ts:410,609`; `repro-grounding.ts`; 소비 `driver/repro-test-prep.ts:392-475` | 있음-배선 |
| adversarial-repro | schema `bench-b.ts:343`; posture `knobs-bench.ts:265,622`; 소비 `driver/repro-test-prep.ts:278-280,692` | 있음-배선 (tie-break/seed 전용, submit-gate엔 절대 안 닿음) |
| extract-issue-repro seed | `src/agent/verification-plan/extract-issue-repro.ts:129` | 있음-배선 |

**상태: 재조립 가능.** repro 생성 경로 + grounding + adversarial 변형 전부 배선됨.

### 4. base-run (repro를 base 트리에서 실행 = base-RED 재현 확인)
| 부품 | knob/코드(file:line) | 상태 |
|---|---|---|
| in-loop-exec 실행 권한 | schema `bench-a.ts:166`(default full); posture `knobs-bench.ts:355,677`; `bench-in-loop-exec.ts` | 있음-배선 |
| repro-adapter (polyglot 실행 계약) | `repro-adapter.ts:80-116`(Python adapter, host backend byte-identical) | 있음-배선 |
| repro-image-exec (image backend) | `repro-adapter.ts:155`(preferredReproExecRuntime), knob `QUANTA_BENCH_REPRO_IMAGE_EXEC` | **있음-미배선** (RFC Phase 2b DEFERRED, `repro-adapter.ts:159-166`; default `{}`⇒host. Python 패치 shadow 미검증) |
| base-RED 재현 게이트 (MWE가 base서 fail=버그재현) | `mwe-proof-port.ts:74-84`, `mwe-proof.ts`; verify-select 경로에 주입 | 있음-배선 |

**상태: 재조립 가능** (host backend). base 트리에서 repro 돌려 base-RED(=재현) 판정하는 축이 존재.
image-backend만 미배선(측정용 opt-in, Verified/Live는 host로 byte-identical).

### 5. execution-review (3차원 oracle)
| 부품 | knob/코드(file:line) | 상태 |
|---|---|---|
| repair-strong-oracle (green round 다중신호 conjunction) | schema `bench-b.ts:106`; posture `knobs-bench.ts`; **로직 `repair/strong-oracle.ts:65-78`** | 있음-배선 |
| — 축1 base-discrimination | `strong-oracle.ts:19-21` (`v.ok`, validator가 base-RED/patch-GREEN일 때만 true) | 있음-배선 |
| — 축2 declared-expected match | `strong-oracle.ts:48-49` (`v.predicate.matched`) | 있음-배선 |
| — 축3 repro-vote K-of-N consensus | `strong-oracle.ts:55-56` (`v.consensus`); `repair/repro-vote.ts` | 있음-배선 |
| acceptance (score-once rerank 셀렉터) | schema `bench-repro.ts:75`; posture `knobs-bench.ts:404,608`; `driver/repair-phase.ts:366-387` | 있음-배선 |
| submit-review (observe-only 최종 verdict) | schema `bench-gap-3.ts:274`; readSite `driver/selection-port-factories.ts:291-297` | 있음-배선 (관측 전용) |
| repro-oracle-calibration (gold false-neg 가드) | `repro-oracle-calibration.ts:77` | **있음-배선(단 EVAL-ONLY)** — gold 필요, live 무효(파일 head:5 "not a production capability"). 재조립 대상 아님. |

**⚠️ 핵심 갭**: ReProAgent의 "**cheap fix-free post-fix-viability**"(고쳐도 영영 못 통과할 구조를 repair 소비 **전에** reject)에
정확히 대응하는 게 **없음**. 우리 것은 전부 **post-fix**:
- strong-oracle = 패치 생성 **후** green round를 다중신호로 걸러냄(false-green 억제).
- mwe-proof = base-RED **재현** 확인(버그 존재), viability 아님.
- calibration = **gold** 기반, live 무효.

즉 "repair 돌리기 전에 이 config는 구조상 통과 불가"를 fix-free로 판정하는 축은 **없음(신규 필요)**.

### 6. repair loop
| 부품 | knob/코드(file:line) | 상태 |
|---|---|---|
| repair-breadth (best-of-N) | schema `bench-gap-3.ts`(location-fanout 근처); `repair-breadth.ts`; `driver/repair-phase.ts:38,325` | 있음-배선 |
| location-fanout (per-candidate seed) | schema `bench-gap-3.ts:315`; `location-set-fanout.ts`; `driver/attempt-context.ts:475`, `driver/selection-port-factories.ts:33` | 있음-배선 |
| effort-ladder (tier→adaptive limits) | schema `bench-gap-3.ts:289`; `adaptive-escalation/effort-ladder.ts:52`; **invoke `driver.ts:144`**(resolveEffortLadderLimits) | 있음-배선 |
| repro-vote (K-of-N 재결) | `repair/repro-vote.ts` | 있음-배선 |

**상태: 재조립 가능.** breadth + fanout + effort-ladder + vote 전부 배선.

---

## 핵심 질문 답

**preset 하나로 켤 수 있나?** — **거의 그렇다.** `agentless-v7-oracle-multifile`(preset-specs.ts:307-341)이
1~6단계의 배선된 레버를 사실상 전부 켠다: issue-hint(+expected-actual), verification-plan, primary-rail,
repair-spec-gate, repro-test:5, repro-grounding, repro-vote, repair-strong-oracle, acceptance, repair-breadth:3,
location-fanout, cha-multisite-steer/-general, in-loop-exec:full. **이 한 preset id로 ReProAgent 뼈대의 배선된
전부가 켜진다.** (submit-review, effort-ladder, repro-image-exec는 이 preset에 없어서 별도 env로 추가 — 전부
default-OFF env-direct라 preset과 조합 가능.)

**어느 단계가 신규 배선 필요한가?**
- **단계 5의 "post-fix-viability(fix-free reject)" = 없음 = 신규 코드 필요.** 이게 유일한 진짜 갭. 나머지 6단계는
  전부 이미 배선. 우리 최근접물(strong-oracle/mwe-proof/calibration)은 전부 post-fix 또는 gold-only라 "고치기 전
  구조적 통과불가 reject"를 못 함.
- **단계 4의 repro-image-exec = 있음-미배선**(코드 존재, RFC Phase 2b DEFERRED, Python shadow 미검증). Verified/Live는
  host로 재조립되므로 이건 blocker 아님 — Pro image 실행 최적화용.

**재조립 vs 신규 (단계별 결론):**
1 localize — 재조립 가능
2 root-cause/assertion-plan — 재조립 가능 (issue가 명시 안하면 무배선 fail-open은 설계 한계, 버그 아님)
3 test-gen — 재조립 가능
4 base-run — 재조립 가능 (host); image-exec만 미배선(비-blocker)
5 execution-review — post-fix oracle 3축은 재조립 가능 / **fix-free viability reject는 신규 필요**
6 repair loop — 재조립 가능

---

## 10줄 요약
1. ReProAgent 7단계 중 **6단계가 이미 배선**돼 있고 `agentless-v7-oracle-multifile` preset 하나로 대부분 켜진다.
2. localize(1): issue-hint/forward-localize/cha-multisite/LSP 전부 배선(bench-a.ts, bench-b.ts, driver.ts:154).
3. root-cause/assertion-plan(2): verification-plan+primary-rail+declared-expected+repair-spec-gate 배선(repair-phase.ts:18,316).
4. "fix되면 뭐가 맞나"는 `extractIssueDeclaredExpected`(extract-issue-declared-expected.ts:130)로 PUBLIC text서 typed predicate 고정—있음.
5. test-gen(3): repro-test K + repro-grounding + adversarial 전부 배선(bench-repro.ts, repro-test-prep.ts:392).
6. base-run(4): in-loop-exec + repro-adapter(host) + base-RED mwe-proof 배선. image-exec만 미배선(DEFERRED, 비-blocker).
7. execution-review(5): strong-oracle 3축(base-disc/declared-expected/repro-vote) + acceptance + submit-review 배선(strong-oracle.ts:65).
8. **유일한 진짜 갭**: ReProAgent "cheap fix-free post-fix-viability reject"(고치기 전 구조적 통과불가 배제)에 대응물 **없음=신규 필요**.
9. 우리 최근접물은 전부 post-fix(strong-oracle) 또는 gold-only(calibration)라 "repair 소비 전 fix-free reject"를 못함.
10. repair loop(6): breadth+location-fanout+effort-ladder(driver.ts:144)+repro-vote 배선. **결론: preset 1개+env 몇 개로 6/7 재조립, 단계 5의 fix-free viability만 신규 배선 필요.**
