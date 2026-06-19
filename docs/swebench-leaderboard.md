# SWE-bench Verified — Local Leaderboard

로컬(arm64 Docker, official Python harness) 정식 채점으로 **resolved** 된 인스턴스 기록.
preset/model 별로 실제 통과한 것만 올림. FAIL/미시도는 별도 섹션.

> **머신리더블 SSOT = [`swebench-leaderboard.yaml`](swebench-leaderboard.yaml)** (run 블록별 resolved 리스트). 이 md는 사람이 보는 큐레이션 뷰 — 전체 resolved 인스턴스는 yaml 참조.

## 🚀 커버리지 확장 — untried E-class 스윕 (2026-06-19) · **26/26 = 100%**
`scaffold-solving-summary.md`(500×17 SOTA 스캐폴드 매트릭스)로 **cnt(몇 개 스캐폴드가 푸나)**를 가성비 신호로 사용 — 난이도 라벨(`<15min`)은 CEILING(아무도 못 품)을 섞어 부적합했음. **cnt≥14 (E-class, 14~17/17 스캐폴드가 푸는 = 거의 확실히 회복가능)** untried를 cnt 높은 순으로 타게팅:
- **batch1 12/12 + batch2 14/14 = 26/26 (100%)** — 전부 cnt=17 django, agentless-v2, on-demand(spot reclaim 회피)+prebaked AMI. run_id `eclass-untried-sweep-2026-06-19`.
- **batch4 11/13 + batch5 9/13 + batch7 9/13 = 29** — django E-class 계속. run_id `eclass-untried-sweep-b457-2026-06-19`.
- **batch3-slice 12/14 + batch6 9/13 = 21** — run_id `eclass-untried-sweep-b36-2026-06-19`. (batch3는 박스 하나가 16145서 hang했으나 같은 슬라이스 중복 박스가 12/14로 완주 → 거기서 수확.)
- 누적 유니크 resolved = **181 / 500**. 타게팅 원칙: **E-class untried(cnt≥14) 우선, CEILING(cnt=0) skip(0 ROI), 길고 어려운 M/H는 보류.**
- 진행 중: 박스 3개(15.164.228.253, 13.209.72.221, 54.180.95.91) grading중 — 끝나면 수확.
- ⚠️ 인프라 교훈: **박스 run.log = 결과 정본**(box→local 스트리밍 자주 끊겨 로컬 sweep 로그가 patch-gen에서 멈춤=거짓). 회수는 박스 ssh로. 또 per-instance patch-gen 타임아웃 없어 1개 hang이 배치 grading 배리어를 막음(16145) → 중복 박스가 구제.

## 🥇 easy django T1+T2 — **82/84 resolved (97.6%)** · closure-bundle 회복 (2026-06-18)

위 78/84(baseline preset)에서 미해결이던 6개를 **agentless-v2**(closure 6-knob 전부 ON + LSP-steer, **코드변경 0**)로 EC2 full-remote 재solve → **4/6 회복**. run_id `easy-unresolved-recover-2026-06-18`.

| | baseline 78/84 | agentless-v1 A/B | **agentless-v2 (이번)** | mini-swe baseline |
|---|---|---|---|---|
| 9296 (no-patch) | ❌ | ✅ | ✅ | ✅ |
| 15987 (over-engineer) | ❌ | ✅ | ✅ | ✅ |
| 16642 (패치오염) | ❌ | ✅ | ✅ | ✅ |
| **10914 (localize-miss)** | ❌ | **❌** | **✅** ← v1이 못 잡던 거 | ✅ |
| 14315 (multi-site) | ❌ | ❌ | ❌ | ❌ |
| 16667 (repro symptom) | ❌ | ❌ | ❌ | ❌ |
| **합계** | 0/6 | 3/6 | **4/6** | **4/6** |

- **결과: easy django 78→82/84 (97.6%).** 잔존 2개 django(`#14315` multi-site, `#16667`) + light `pylint-4970`.
- **핵심**: closure bundle(no-patch-breaker/patch-hygiene/repair-escalation)이 agentless-v1 A/B보다 **+1**(`#10914` localize-miss). localize 병목도 typed-rail repair-escalation으로 일부 뚫림.
- **🤖 mini-swe baseline 교차검증 (2026-06-18, EC2 x86 native, error 0)**: 같은 6개를 표준 스캐폴드 mini-swe-agent(gpt-5.4 oauth)로 standalone 재solve → **4/6, quanta-v2와 인스턴스 단위 1:1 완전 동일**(✅10914 15987 16642 9296 / ❌14315 16667). 즉 (a) 잔존 2개는 **모델 천장**(mini도 같은 원인 실패: 14315=base/client.py 미접촉 multi-site 누락, 16667=`except (ValueError,OverflowError)` 합쳐 복구값 `"0-0-0"` 대신 near-miss). (b) **10914(localize-miss)를 mini는 baseline으로 잡음** — quanta-v1이 closure 없이 못 잡고 v2가 6-knob 전부 켜서 겨우 따라잡은 걸 mini는 맨몸으로 해결 → closure bundle의 10914 회복은 quanta 하네스가 baseline에서 더 어렵게 만든 걸 메운 측면. 산출물 `mini-swe-gpt5.4.mini-django6-2026-06-18.json`, patch-gen `/tmp/mini-django6/`.
- 잔존 3개 RCA: `#14315`=multi-site repro 후보 0(base만 재현, postgresql co-change 미발견) / `#16667`=**in-loop repro env 미스매치**(host py3.9 vs django5.0 py≥3.10 → exec_failed 5/5) + near-miss wrong-value / `pylint-4970`=가드 위치 오배치(gold=`run()` early-return; repro는 resolved 3/5인데 채점 fail). → WAVE B 직교레버: find-refs co-change(14315) · repro python-version 정합(16667) · constraint-reasoning(4970).
- 4개 전부 공식 harness `passed:true`(infra error 0, completed_unresolved 3). 박스 grade 후 terminate.

## 🏆 easy django T1+T2 — **78/84 resolved (92.9%)** · EC2 네이티브 채점 (2026-06-17)

가장 완전한 authoritative 결과 (run_id `quanta-easy-django-ec2-2026-06-17`). 83개 패치(blind, gpt-5.4 chatgpt-oauth) 전부 **EC2 c7i x86 네이티브**로 공식 swebench harness 채점, **infra error 0**.

- **resolved 78 / unresolved 5 / no-patch 1 = 84.** unresolved(진짜 model-miss): `#10914 #14315 #15987 #16642 #16667`. no-patch: `#9296`(max-turns).
- **🔧 RCA 2건 구조해결**:
  1. EC2 scp `connection refused` → `ec2.ts`가 `instance-running`만 기다리고 sshd/cloud-init 부팅 전에 scp → **ssh-ready + `cloud-init status --wait` 폴링 추가**([ec2.ts](../src/apps/bench/remote/ec2.ts)).
  2. 1차 채점 76 infra-error → `max_workers=24`로 fresh 박스가 84 이미지 동시 pull → 리소스/pull exhaustion → **max_workers 6으로 낮춰 error 0.**
- 채점 박스는 `--keep` 후 수동 terminate (비용 캡). 전체 resolved 목록 = yaml.

### 실패 6개 RCA/정형화

`#9296`는 **model-miss 아님** — `max_turns(60턴)+빈패치`: 자명한 4줄(`Paginator.__iter__`)을 60턴 안 커밋하고 탐색/verify만 돔 = 에이전트 over-exploration(하네스), 능력 아님. 재시도 대상.

5개 model-miss는 전부 **"right neighborhood, wrong exact fix"** (localize는 맞고 정밀 synthesis/절제가 틀림):

| # | 골드 | 에이전트 패치 | 실패유형 |
|---|---|---|---|
| 10914 | `global_settings.py` 1줄 (`FILE_UPLOAD_PERMISSIONS=0o644`) | `storage.py`에 umask chmod 로직 | **wrong-file + over-engineer** (1줄 상수변경을 권한로직으로 과해석) |
| 14315 | base/client.py + **postgresql/client.py** (`env if env else None`) | base만 `if env is not None` | **multi-site 누락 + 로직오류** (`{}`→None 폴백 안 함) |
| 15987 | `app_dir in [str(d) for d in dirs]` | `[Path(d).resolve() …]` | **over-engineer** (str() 한 줄 대신 .resolve() side-effect) |
| 16642 | dict에 `br`/`compress` 추가 | `compress`만+`br` 이상 조건문 + **stray test.html.Z/.br** | **wrong-logic + 패치 오염** |
| 16667 | `except OverflowError: return "0-0-0"` 별도 절 | `except (ValueError,OverflowError)` 합침 | **near-miss wrong-value** (예외 잡고 복구값 틀림) |

**결론**: easy 티어 미스의 병목 = gross localize가 아니라 **fix 정밀도**(constraint-reasoning·절제·multi-site 일관성). #10914·#15987은 trivial을 과구현하는 over-engineering 역방향 실패. → grep-천장 분석(동네 찾되 정밀 갭)과 일치, 코드그래프(find-refs/impact)는 #14315 multi-site엔 도움되나 나머지(정밀 synthesis/절제)는 grounding 밖.

### 🔬 실행피드백 A/B — baseline 실패 6개만 재실행 (agentless-v1, 2026-06-17)

위 78/84는 **baseline preset**(no agentless 도구). 그 실패 6개를 **agentless-v1**(lsp+localize-phase+issue-hint+repro-test 실행피드백)로만 재solve→EC2 채점:

| | baseline | agentless-v1 | Δ |
|---|---|---|---|
| 실패6개 resolved | 0/6 | **3/6** | +3 |

- ✅ 회복: `#15987`(over-engineer), `#16642`(wrong-logic), `#9296`(baseline은 max-turns 빈패치 → issue-hint+repro로 해결)
- ❌ 잔존: `#10914`(1줄 global_settings = **localize 병목**, 53턴/6edit churn), `#14315`(**multi-site** base+postgresql), `#16667`(**repro 증상유효성** — 예외는 잡고 복구값 오류)

**측정 인사이트**: 실행피드백(repro 루프)이 baseline 실패의 **50%를 회복**. 잔존 3개는 정확히 적대어딧이 짚은 3클래스(localize-miss / multi-site / repro-symptom-validity) — 즉 실행피드백은 **fix 정밀도는 잡아도 "어느 파일"(localize)·multi-site·repro 유효성은 못 잡음**. 다음 레버는 이 3축(코드그래프 find-refs proactive·repro expected-assert)이며 실행피드백 위에 직교로 쌓아야 함을 실측 확인.

## 📊 easy django T1+T2 batch (2026-06-16, scaffold-fixed) — 39 resolved

우리 정형화 분석의 easy 티어(T1 존나쉬움 + T2 쉬움) django 84개 블라인드 런. **bench 스캐폴드 2버그 구조수정 후** 측정:
deadline을 env-setup 후 arm + 기본 per-instance 타임아웃 2분→10분 + bench stale-read-guard off
([driver.ts](../src/apps/bench/eval/driver.ts), [index.ts](../src/apps/bench/index.ts)).
**효과: abort 74%(39/53) → 0%.** 같은 gpt-5.4가 mini-swe-agent 수준으로 회복 — quanta가 틀렸던 django-12039·12304가 수정 후 PASS(스캐폴드 탓 확정, 모델 아님).
confirmed **resolved 39 django** (remaining 런 진행 중, 전체 목록은 yaml).

- harness: `QUANTA_SWEBENCH_PYTHON=1` + prebuilt amd64 이미지 pull → 에뮬레이션 실행 (max_workers=1)
- grading 신뢰도: ★★★ (가짜 testCmd=true 아님, 실제 FAIL_TO_PASS 통과)

## picks-10 (agentless-v1, gpt-5.4) — 5/10 resolved (= 5/9 patch-bearing = 55.6%)

**EC2 교차검증 (2026-06-15, c7i.8xlarge spot, native, run_id=quanta-ec2-r2)**: 동일 패치를
x86 네이티브로 재채점 → **resolved 5/10, error 0, 56초**(arm64 에뮬레이션 몇시간 대비). 로컬
5 resolved와 정확히 일치. 로컬의 "infra fail 2개" 정체 해소: pytest-5787은 진짜 unresolved
(model miss, 로컬 harness_error는 경합 노이즈), sympy-12489는 빈 패치(patch-gen 실패).

**로컬 병렬 재검증 (2026-06-15, concurrency=4, probe-fix + fake-fallback 제거 후)**: 로컬 arm64에서
patch-gen 4-way 병렬 + grading mutex 직렬로 재실행 → **resolved 5/10, harness_error 0**(이전
직렬 런의 infra-fail 2개가 이제 전부 진짜 completed_unresolved). 병렬화가 정확성 안 바꿈(직렬·EC2와
동일 5개) + silent fake 폴백 제거로 모든 실패가 신뢰 가능한 verdict. import-probe 15s→60s(swebench
import이 idle 9~13s라 부하 시 초과해 fake로 폴백하던 버그) + swebench 인스턴스 testCmd 폴백 차단.

## ✅ Resolved

| instance | repo | preset | model | turns | date |
|---|---|---|---|---|---|
| psf__requests-5414 | requests | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 16 | 2026-06-15 |
| sympy__sympy-16886 | sympy | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 19 | 2026-06-15 |
| pallets__flask-5014 | flask | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 23 | 2026-06-15 |
| sympy__sympy-13480 | sympy | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 16 | 2026-06-15 |
| pytest-dev__pytest-7982 | pytest | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 17 | 2026-06-15 |

## ⛔ 채점불가 — grading env false-negative (gold도 fail; 모델 무죄)

| instance | repo | 확인 | date |
|---|---|---|---|
| sphinx-doc__sphinx-8595 | sphinx | 에이전트 패치 = gold와 byte-identical. **gold 패치 직접 채점해도 동일하게 unresolved**(applied:True, test_empty_all fail). 로컬 instances.jsonl test_patch ↔ prebuilt `swebench` 이미지 환경 불일치(로그에 Sphinx-3.5.0.dev 재설치). EC2도 동일 재현. → 점수 산정에서 제외. 모델은 사실상 정답. | 2026-06-15 |

## ❌ Unresolved — model miss (real, agent 패치가 gold와 명확히 다름)

| instance | repo | preset | model | reason | date |
|---|---|---|---|---|---|
| pylint-dev__pylint-8898 | pylint | agentless-v1 | gpt-5.4 | quantifier `{1,}` 콤마 split을 shlex로 잘못 처리(brace-aware 파서 필요); 1파일로 풀리는 문제, 모델 추론 미스 | 2026-06-15 |
| pylint-dev__pylint-4970 | pylint | agentless-v1 | gpt-5.4 | 가드를 `_compute_sims()`에 넣음(gold는 `run()`에 early-return); 위치/의미 미묘하게 빗나간 near-miss | 2026-06-15 |
| pytest-dev__pytest-5787 | pytest | agentless-v1 | gpt-5.4 | 미완성 — chained exception 직렬화를 절반만(4369자 vs gold 9824자) | 2026-06-15 |
| sympy__sympy-12489 | sympy | agentless-v1 | gpt-5.4 | 대폭 미달 — Permutation 서브클래싱 광범위 수정 필요한데 1109자만(gold 9648자) | 2026-06-15 |

## ⚠️ 로컬 infra fail → EC2 재채점으로 해소 (2026-06-15)

| instance | repo | 로컬 | EC2 네이티브 재채점 결과 |
|---|---|---|---|
| pytest-dev__pytest-5787 | pytest | harness_error(경합) | **unresolved (진짜 model miss)** — 인프라 아님 |
| sympy-dev__sympy-12489 | sympy | code 143 SIGTERM(경합) | **empty patch** — patch-gen 실패(채점 무관, 재생성 필요) |

## 🤖 mini-swe-agent baseline (표준 스캐폴드, gpt-5.4 via 로그인)

quanta(agentless-v1)와 **별개 스캐폴드**인 mini-swe-agent v2를 같은 gpt-5.4(로그인)로 돌린 per-instance 해결여부.
스캐폴드 차이가 결과를 가르는지 비교용 칼럼. `✅`=resolved, `❌`=unresolved, 빈칸=미시도.

- 실행: `~/swe-bench-tools/mini-login.sh -y -l 0 --exit-immediately -t "<problem_statement>"` (base_commit 워크트리 cwd)
  - 로그인 경로: mini(litellm) → `_data/oauth-proxy.ts`(:8765) → quanta `createLLM("chatgpt-oauth")` → gpt-5.4 (raw key 불요)
- 채점: mini 패치 → `mini-predictions.jsonl` → **공식 swebench harness**(`run_evaluation`, arm64 에뮬, max_workers=1, namespace=swebench) — quanta 칼럼과 **동일 grader**라 apples-to-apples. 산출물: `docs/analysis/swe-bench-verified-analysis/_data/mini-picks10-{predictions.jsonl,report.json}`.

### 🔴 GRADING BUG (2026-06-19) — 동시 채점이 정답 패치를 false-negative → 여러 결론 철회

**self-inflicted 버그**: full-remote 온박스 채점에 `QUANTA_SWEBENCH_GRADE_CONCURRENCY=6`(내가 추가)을 주면 인스턴스별 `run_evaluation` Docker 채점이 **동시에** 돌며 공유 run_id 이미지캐시/cleanup을 race → **정답 패치를 unresolved로 오판.**

**증명 (same patches, two graders)**: v2-safe 5패치 → 동시채점 **0/5** vs 안전 grade-only **4/5**. 그중 3개(21847·10914·9296)는 **gold와 byte-identical + `git apply --check` clean**인데도 동시채점선 fail. → **fix: full.ts 채점 SERIAL로**(patch-gen 동시는 유지) + 재발방지 헬게이트 + knob UNSAFE 표기.

**이 버그로 오염돼 철회된 결론들:**
- ❌ ~~"v2-safe 0/5 = restraint 더 나쁨"~~ → 진짜 **4/5**. restraint 안 나쁨.
- ❌ ~~"21847 = quanta 과구현 자폭, mini만 풂"~~ → serial 재채점선 **v2·v2-safe·mini 셋 다 21847 ✅.** "자폭"은 채점버그 신기루.

### untried-sympy-6 — mini 2/6 vs quanta(agentless-v2) 3/6 (clean, serial 채점)

위 버그 수정 후 serial 재채점한 진짜 숫자 (yaml `easy-untried-sympy-serial-2026-06-19` + `v2safe-regrade-2026-06-19`):

| instance | quanta v2 (serial) | mini (safe) | 해석 |
|---|---|---|---|
| 19954 | ✅ | ✅ | both-pass |
| 21847 | ✅ (117t) | ✅ | both-pass (← 버그땐 둘 다 "fail"로 오판됐던 것) |
| 19495 | ✅ (131t) | ❌ | quanta 우위 |
| 18763 | ❌ | ❌ | both-fail (단 버그런 patch-gen서는 quanta ✅ → **LLM variance**, 천장 아님) |
| 24562 | ❌ | ❌ | both-fail |
| 20916 | ❌ | ❌ | both-fail |

- **quanta 3/6, mini 2/6** — quanta가 19495 하나 더(exec-feedback). 21847은 양쪽 다 풂.
- **메타 교훈**: 측정 인프라(채점) 버그가 며칠치 결론을 오염시킴. "0/5 restraint 더 나쁨"·"과구현 자폭" 둘 다 가짜였고, **gold-identical + apply-check로 패치를 직접 검증**해서야 들통남. 단일 verdict 숫자 믿지 말고 패치를 까봐야 함.

### picks-10 — mini 5/10 vs quanta(agentless-v1) 5/10 → **인스턴스 단위 1:1 동일**

mini가 10개 전부 골드 파일 적중(picks=light 티어). resolved/unresolved 분할이 quanta와 정확히 일치 — 스캐폴드(mini vs 우리 harness 강제)가 결과를 안 가르고 **모델+localization이 결정**.

| instance | repo | mini | quanta | 근거 |
|---|---|---|---|---|
| psf__requests-5414 | requests | ✅ | ✅ | both resolved |
| pallets__flask-5014 | flask | ✅ | ✅ | both resolved |
| sympy__sympy-13480 | sympy | ✅ | ✅ | both resolved |
| sympy__sympy-16886 | sympy | ✅ | ✅ | both resolved |
| pytest-dev__pytest-7982 | pytest | ✅ | ✅ | both resolved |
| pylint-dev__pylint-4970 | pylint | ❌ | ❌ | both miss — 가드 위치 near-miss(gold=`run()` early-return) |
| pylint-dev__pylint-8898 | pylint | ❌ | ❌ | both miss — brace-aware 파서 필요, 1파일만 수정(gold 3파일) |
| pytest-dev__pytest-5787 | pytest | ❌ | ❌ | both miss — chained-exception 직렬화 미완성 |
| sympy__sympy-12489 | sympy | ❌ | ❌ | both miss — Permutation 서브클래싱 대폭 미달 |
| sphinx-doc__sphinx-8595 | sphinx | ⛔ | ⛔ | **grading false-neg**: 골드 패치도 이 harness서 fail(env 불일치). 양쪽 모델 무죄, 점수서 제외 |

**합계: mini 5/10 resolved (= 5/9 patch-bearing), quanta와 동일.**

### hard mislocation 케이스 (별도)

| instance | repo | mini | quanta | 근거 | date |
|---|---|---|---|---|---|
| django__django-15280 | django | ❌ | ❌ | mini가 `django/utils/deconstruct.py`(@deconstructible) 수정 — gold `related_descriptors.get_prefetch_queryset`와 무관 서브시스템(gross mislocation). FAIL_TO_PASS `1 query != 0` 잔존. 골드픽스는 동일 셋업서 GREEN(채점 유효). blind/grep도 같은 mislocation. | 2026-06-16 |

## 🟢 floor 검증 — `agentless-v2-safe` preset (bench-in-loop-exec OFF, 2026-06-16)

스캐폴드 구조수정 2탄: **in-loop 테스트 실행 강제(SWEBENCH_DIRECTIVE "MANDATORY run tests")를 제거**하는 `bench-in-loop-exec` knob + `agentless-v2-safe` preset. host test-env이 incompatible한 인스턴스(pytest-7982 등)에서 에이전트가 못 돌리는 테스트를 강제당해 flail→abort하던 경로를 끊음(edit-and-submit=mini-swe posture; 채점기가 도커서 테스트 실행).

**검증 (pytest-7982, abort→RESOLVED):**

| preset | 결과 |
|---|---|
| agentless-v1 (in-loop ON) | ❌ ABORT — 16턴 pytest collection-error flail, empty_patch |
| **agentless-v2-safe (floor OFF)** | ✅ **RESOLVED** — 9턴, pytest 호출 0, 475B 패치(src/_pytest/pathlib.py=골드), 공식 harness 통과 |

구현: default-ON knob(미설정=byte-identical), `SWEBENCH_DIRECTIVE_NOEXEC` 분기 + verifyGuard/repro/repair 게이트(runner buildConfig + apps runInstanceOnce), 7 hellgate teeth + 438 bench유닛 0회귀 + 3렌즈 적대어딧. 산출물 `_data/floor-validate-pytest7982.json`. agentless-v1 frozen 미접촉. 계획 `~/.claude/plans/bench-exec-posture.md`.
잔여: sphinx-8595(grading false-neg)/pylint-8898(model miss) + 전체 picks-10 v2safe A/B는 transport throttle 풀린 창에서.

## 🧭 grounding 축 — LSP-nav steer (default-ON, 2026-06-17)

스캐폴드 구조수정 3탄(별개 축 = grounding). 측정으로 진짜 갭부터: agentless-v1은 LSP nav 도구(go-to-def/find-refs)를 sandbox-rooted로 **이미** 노출(false-gap)인데 **모델이 ~0%만 호출**(60 트래젝토리 0개). 하드셋 인과어딧의 owner-mislocation + multi-file co-change 미스가 여기서 옴. → localize-phase 가드 메시지에 LSP grounding steer를 **DEFAULT-ON**(nav 켜지면 자동, `QUANTA_BENCH_LSP_STEER=off`로 A/B baseline) 박음. nudge지 hard-gate 아님(django pyright 오탐 회피).

**RCA-fix 2건(full-remote)**: ①serial patch-gen → `QUANTA_BENCH_CONCURRENCY=6`(13분/patch→~4분, TTL위험 해소) ②/tmp dataset 유실 → repo 안정경로.

**A/B (하드 12 multi-site django, full-remote EC2 x86 네이티브 채점):**

| arm | preset | resolved | LSP 사용 |
|---|---|---|---|
| **steer ON** | agentless-v1 | **4/12** (13121/13343/14631/15916), avg 50턴 | `lsp_definition` **27회, 9/12 traj** (0%→75%) |
| steer OFF baseline | agentless-v1-nosteer | ⏳ 미완 | — |

**확정**: steer가 **LSP 사용을 0%→75%로 끌어올림**(메커니즘 실효 측정). **resolved Δ는 미완** — baseline arm이 throttle + 동시런 경합으로 3회 실패(/tmp dataset·spot interrupt·gpt-5.4 throttle), clean 창 필요. 구현: `src/runner/knobs/knobs/lsp-steer.ts`, `knobs-bench.ts`(nav-coupled), `localize-phase-guard.ts`(steer 메시지), `presets.ts`(agentless-v1-nosteer baseline), `remote/full.ts`(concurrency). 테스트: localize 53 + wiring 3 + preset/knob 51 + full-remote 14 = 모두 green.

## 메모
- baseline 비교용: 과거 기록은 gpt-5/gpt-5-mini(OPENAI_API_KEY). 현재 기록은 chatgpt-oauth gpt-5.4라 직접 비교 주의.
- `QUANTA_SWEBENCH_PYTHON_BIN`은 절대경로 필수(sandbox cwd spawn → 상대경로 ENOENT).
