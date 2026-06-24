# jun-24 wave2 핸드오프 — 정적엔진(LSP-이상) 필요여부 어딧 + bench 측정-위생 결함

## 목적 (왜 이걸 했나)

질문: **우리가 못 푼 SWE-bench Verified 인스턴스들을, LSP 이상의 정적엔진(call-graph / data-flow / change-impact / MRO / AST 구조검색)이 있으면 풀 수 있나?** 오라클(gold patch)을 까서 인스턴스별로 "엔진 반드시 필요 / 있으면 도움 / 무관"을 점수화하고, 3입장 적대토론으로 검증.

결론부터: **정적엔진 안 만들어도 된다.** 단, 그 결론에 도달하는 과정에서 **bench 측정 인프라의 실재 결함 여러 개**가 드러났고(이게 이 핸드오프의 핵심), 내 1차 분석은 그 결함들 때문에 **2번 오염→철회**됐다. 다음 세션은 결함부터 막고 깨끗한 데이터로만 움직여라.

관련 메모리: [[no-answer-key-regex-heuristics]] · [[no-heuristics-only-validated]] · [[claim-100-needs-3-adversarial-audits]] · [[jun-22-evidence-signal-audit-and-v5-seam]] · [[jun-20-repro-gen-python-version-rca]]

---

## 결론 (깨끗한 데이터 기반, EC2 없이도 섬)

**유일하게 신뢰 가능한 신호** = `gradeBreakdown` (우리 원격-채점 결과, `~/.quanta/bench/results/*.json` perInstance, model=gpt-5.4, preset=agentless-v3-thin-strict). 33개 미해결 타깃 중 유효 30개:

- **67% (20개) = 못고침(NOT-FIXED)** — `passToPassFailed==0` & `failToPassFailed>0`. 자리 찾았고 기존 테스트도 안 깼는데 **정답을 못 만듦**. = 생성 정확도/repro-오라클 문제. **정적엔진으로 못 고친다.**
- **33% (10개) = 회귀(REGRESSION)** — `passToPassFailed>0`. 고친 게 기존 통과테스트를 깸. (django-11087은 26개나 깸)
- **3개 = grader_invalid** (astropy-7606/8707/8872) — 인프라, 제외.

→ 67% 못고침은 LSP-이상 localization 갭이 아니다. 33% 회귀도 **엔진이 아니라 노브**(아래 #4 `bench-in-loop-exec: off`) 원인 가설. **정적엔진은 둘 다 핵심 레버가 아님.** 기존 메모리(repro-gen 45% 실패, "자리맞고 답틀림" [[jun-20-bestofn-wrong-repro-oracle-root]])와 정확히 수렴 — 새 발견이 아니라 재확인.

> ⚠️ 오라클 어딧(엔진이 도움될 후보 24개 등)은 **반사실(counterfactual) 판정**이었고, 그걸 뒷받침하려던 patch-body enumeration 분석은 **데이터 오염으로 전량 철회**됨(아래 측정-위생). gradeBreakdown만 살아남았다.

---

## 검증된 문제점 (최신 코드 HEAD 기준)

### A. 측정·관측 결함 (이번 오염의 근원 — 최우선)

1. **bench 리포트가 패치 본문을 안 남긴다.** `~/.quanta/bench/results/*.json`의 perInstance 키 = `id/passed/turns/patchBytes/failure/budget/gradeBreakdown` — `model_patch` 없음, `patchBytes`(숫자)만. `--predictions` 안 쓴 overnight 캠페인은 **패치를 영영 잃음** → 33개 중 26개를 사후 분석 불가했음.

2. **bench 아티팩트의 gold-as-ours 풋건.** `.tmp/*.jsonl`(active-rerun·gate-artifacts·04-h-tail)이 **dataset 스키마**(`base_commit`/`FAIL_TO_PASS`/`patch`)로 gold 패치를 품는다. 추출기가 `model_patch ?? patch`로 폴백하면 **gold를 우리 제출로 오인**한다. (해시 대조 확인: 그 파일들 `patch` == verified-full gold.) → 내 "복구한 우리 패치 7개" 중 **5개가 gold, 2개는 frontier**(`_scaffold-summary/bench/_fails-combined.jsonl`은 프론티어 매트릭스라 model_name만 gpt-5.4) = **진짜 quanta 패치 0개**. enumeration 분석 전체가 여기서 무너짐.

3. **로컬 `run`이 채점 안 함** (gradeBreakdown=null 확인). 회귀/resolved 신호는 원격(`grade --mode full`/`--backend ec2`)에서만 나옴.

### B. 스캐폴드·preset 결함 (실제 실패 레버)

4. **기본 preset `agentless-v3-thin-strict`가 `bench-in-loop-exec: off`** (`src/runner/knobs/presets.ts`). agent가 **기존 테스트를 루프 안에서 안 돌린다**(`SWEBENCH_DIRECTIVE_NOEXEC` + single-pass + verifyGuard off). → 회귀 클래스(33%)가 **구조적으로 agent에게 안 보임**. 단 off는 호스트-env 비호환(pytest-7982 등)에서 "테스트 돌려라" 강제 → flail → empty_patch 회피용이라(`bench-in-loop-exec.ts` 닥스) **단순 플립이 정답 아님 = 트레이드오프**.

5. **minimality 스택만 ON, 멀티파일 steer는 OFF.** `round0-minimal:1` + `patch-budget-strict:1` + `spec-fidelity-steer:1` 켜짐 / `QUANTA_BENCH_SIBLING`(driver.ts:1852 env-gate)·`cha-multisite-steer`(knob) 기본 OFF. → 단일파일 편향인데 gold는 멀티파일 多. **과소커버 의심**(효과는 n=1이라 미확정, 구조적 불균형은 사실).

### C. 가드 결함 — 찾음 + 이번에 수정 완료 ✅

6. **answer-key 라쳇이 theater급이었다.** `tests/unit/no-benchmark-overfit-steer-ratchet.test.ts` v1은 (a) driver.ts 로컬 `*_STEER`만 스캔(import된 `LSP_GROUNDING_STEER`/`FIND_REFS_STEER`/`SPEC_FIDELITY_STEER` + `SWEBENCH_DIRECTIVE` 누락), (b) 제거된 3개 steer의 *특정 문자열* denylist일 뿐(새 framework/recipe 못 잡음), (c) red-on-injection이 자기 needle로 만든 문자열이라 tautological. → **v2로 재작성(수정 완료, working tree)**: framework-agnostic 클래스 탐지기(`.py 멀티세그 경로`/`framework+instance번호`/`"for the X issue"`·`rca target gate` 프레이밍/gold-recipe 조각), 스캔 표면 2→12개로 확대, novel framework(flask/requests/pandas)로 진짜 red-on-injection, 동적 `buildMultisiteSteer` provenance 가드. **8/8 통과.**

---

## 이번 세션에 박아둔 변경 (working tree, 커밋 전)

- `tests/unit/no-benchmark-overfit-steer-ratchet.test.ts` — 라쳇 v2 재작성 (위 #6). **남길 것.**
- `src/runner/knobs/presets.ts` — `agentless-v3-thin-strict-execfull` 추가 (thin-strict와 100% 동일, `bench-in-loop-exec: "full"`만 다름. exec 레버 단일변수 A/B용). **남기면 다음 캠페인서 공짜 측정 / 안 쓰면 삭제.**

> ⚠️ 세션 시작 시 유저 in-flight 수정(`src/runner/batch/eval/driver.ts` 등 M 상태)이 있었음 — 블라인드 `git add -u`/`-A` 금지([[sweep-and-macos-sed]]). 커밋하려면 위 2개 파일만 명시적으로.

---

## ⚠️ 측정-위생 교훈 (다음 세션이 반드시 읽을 것)

이번 분석이 **2번** 오염됐다. 같은 실수 반복 금지:

1. **provenance 먼저 까라.** `~/.quanta/bench/results`에서 결론 내기 전에 report의 `timestamp` / `model` / `knobs.preset`을 **커밋 294b40a8(2026-06-22 14:14, answer-key `*_STEER` 제거) 기준**으로 확인. 그 이전 런은 answer-key 오염(33개 중 8개가 키워드 매칭). [[jun-22-scaff-northstar-3-measured]]
2. **gold를 ours로 읽지 마라.** dataset 스키마(`base_commit` 키 존재)면 그 `patch`는 GOLD다. prediction은 **`model_patch` 필드만** 신뢰. `_scaffold-summary/`는 프론티어(경쟁사)다.
3. **n=1 패치 파일커버리지는 노이즈 지배** — clean 대조군(steer 0)도 6→1로 무너졌었음(사실은 gold-vs-ours 오비교였지만, 별개로 n=1은 못 믿는다). 구조 비교는 n≥5 + model_patch-only로만.
4. **gradeBreakdown(passToPassFailed/failToPassFailed)은 run 결과라 신뢰 가능** — 이건 gold 아님. 단 `grader_invalid`/empty-patch는 제외(real_attempt만). [[jun-20-leaderboard-throttle-miss-confound]]

---

## 앞으로 해야 할 것 (우선순위 = 기능 + 왜 + ROI)

**P0 — gold-as-ours 풋건 가드** (#2)
- 기능: bench 패치 추출 경로에서 dataset-스키마 행(`base_commit`/`FAIL_TO_PASS` 존재)의 `patch`를 prediction으로 읽으면 throw. prediction은 `model_patch`만.
- 왜: 이 풋건 하나가 분석 전체를 조용히 오염시킴(gold를 우리 걸로). 재발 확률 큼.
- ROI: **매우 높음** — ~30분, 영구 재발방지. red-on-injection 테스트로 teeth.

**P1 — 리포트에 패치 증거 저장** (#1)
- 기능: perInstance에 `model_patch` digest + touched-files(파일목록) 저장(또는 캠페인 기본 `--predictions` 강제).
- 왜: "우리가 뭘 고쳤나"를 사후 감사 불가 → 26/33 패치 소실. enumeration/멀티파일 분석의 전제.
- ROI: 높음 — 모든 향후 patch-level 분석을 가능케 함.

**P2 — exec 트레이드오프 측정** (#4, execfull preset 활용)
- 기능: `agentless-v3-thin-strict` vs `agentless-v3-thin-strict-execfull` A/B를 **다음 정규 캠페인에 끼워** 회귀감소 vs flail(empty_patch) 비용 측정.
- 왜: 유효실패의 33%가 회귀인데 현재 agent에겐 구조적으로 안 보임. 단 off는 flail 회피용이라 net 효과 미지.
- ROI: 중간 — 회귀 일부 회복 가능하나 트레이드오프. **별도 EC2 태우지 말고** 캠페인에 무임승차.

**P3 — 생성 정확도 / repro-오라클** (진짜 1순위 병목)
- 기능: 67% 못고침 = 자리 맞고 답 틀림. repro-오라클 품질 + 생성 정확도 개선(기존 [[jun-19-repro-vote-and-theater-class]] / v5 oracle-first 라인).
- 왜: 지배적 실패모드. 정적엔진으로 못 고침. 메모리 측정과 수렴.
- ROI: **가장 높지만 가장 어려움.** 정적엔진보다 여기에 투자.

**P4 — 멀티파일 과소커버 확정/반증** (#5)
- 기능: model_patch-only로 "우리 패치 파일수 vs gold 파일수" n≥5(멀티파일 gold) 측정. (P1 선행 필요)
- 왜: minimality 편향이 멀티파일 버그를 1파일로 깎는지 미확정.
- ROI: 중간 — P1 들어가면 싸짐. 확정되면 sibling/cha-multisite steer 켜기로 연결.

**비-목표(하지 마라)**: LSP-이상 정적엔진(call-graph/data-flow/KG) 신규 빌드. 깨끗한 데이터가 핵심 레버 아니라고 말함. 적대토론 3입장 중 "엔진으로 다 풀린다(B)"는 측정에서 반증됨(우리가 자리 다 찾고도 틀린 못고침이 다수).

---

## 재현 방법 (커맨드)

```bash
# gold 오라클 (SSOT, 500행)
docs/analysis/swe-bench-verified-analysis/_data/verified-full.jsonl

# gradeBreakdown 깨끗 신호 재집계 — ~/.quanta/bench/results/*.json perInstance
#   real-attempt 필터: termination!=grader_invalid && patchBytes>=50
#   passToPassFailed>0 → REGRESSION, ==0&failToPassFailed>0 → NOT-FIXED

# 로컬 patch-gen (채점 안 됨, model_patch만 — acct-a로 유저 chatgpt.json 안 건드림)
bun run src/apps/bench/cli.ts run --swebench <DS> --instance <ids> --n 1 \
  --report /tmp/r.json --predictions /tmp/p.jsonl \
  --auth-file ~/.quanta/auth/chatgpt-acct-a.json

# 원격 채점 A/B (정본, EC2 $ — 명시 승인 필요. --dry-run 먼저)
bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets --dataset <DS> \
  --instance <ids> --preset agentless-v3-thin-strict[-execfull] \
  --auth-file ~/.quanta/auth/chatgpt-acct-a.json --dry-run

# 라쳇
bun test tests/unit/no-benchmark-overfit-steer-ratchet.test.ts   # 8/8

DS=/Users/songmin/Documents/code-new/quanta-benchmark-corpus/external/swebench/verified/raw/instances.jsonl
```

회귀 큰 5개(P2 A/B 후보): django-11087(26) / django-14170(9) / matplotlib-25960(6) / astropy-13398(5) / django-11400(5).

---

## 한 줄 요약

조사 끝. **정적엔진 X** (67% 못고침=생성, 33% 회귀=exec노브). 진짜 가치는 **bench 측정-위생 결함 6개** 발견 + 라쳇 보강(완료). 다음: P0 풋건가드 → P1 패치저장 → P3 생성/repro. EC2 추가지출 불필요.
