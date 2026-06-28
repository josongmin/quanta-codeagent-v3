# jun-28 Handoff — agent-1 (closure-repair oracle activation + bench infra)

작성: 2026-06-28. 다음 에이전트가 바로 집을 수 있게 **남은 일 + 필요한 context**를 남김.
관련 메모리: `[[jun-28-closure-repair-spec-gate-activation-and-wiring-guard]]`,
`[[jun-28-otel-sink-no-runid-attribution-gap]]`, `[[jun-27-11141-model-gap-controlled]]`,
`[[jun-28-red-campaign-xarray-oom-and-tally-hygiene]]`.

---

## 0. 이번 세션에 LANDED (전부 main 푸시됨)

| commit | 내용 |
|---|---|
| `7e36fe007` | closure-repair spec-gate **inert-#2 가드** — compose-결정을 단일 seam `resolveRepairEvaluatePredicate`로 추출, 양 driver 배선 + wiring 테스트 (418 green) |
| `782712035` | dashboard — 해결 **소요시간 ⏱ + 해결시각 📅** 칼럼 (승리 프로파일 옆) |
| `d17757a82` | bench — xarray **fork-storm nproc 캡** (`ulimit -S -u 2048`); exit-137 OOM(`uv` ~4700 fork) 측정구멍 차단 |

레버 4개(assertion-pin / declared-expected gate=`repair-spec-gate` / breadth / strong-oracle)는
이전 세션에 main 랜딩, **전부 default-OFF**(byte-identical 불변식), no-leak fence 유지.

---

## 1. 남은 일 (우선순위순)

### #1 — 활성화된 #2 유효 재측정 ★최우선
- **기능:** `agentless-v6-closure-tuned`(= closure-repair + `repair-spec-gate:1`) vs `agentless-v6-closure-control` (또는 vs `agentless-v6-closure-repair`) A/B를, **baseline(singlepass)이 실패한 케이스**에 던짐.
- **왜:** 이전 closure-tuned "0 recovery" 측정은 **#2가 inert인 상태**(driver가 raw 넘김)라 **무효**. `7e36fe007`로 진짜 활성화됨 → 처음으로 "활성 레버가 baseline 넘나"를 실측.
- **ROI:** 최상 (전체 closure 작업의 readout).
- **readout 축:** resolved Δ 뿐 아니라 **오라클 정합성**(repro_red_but_unresolved, gate_enter_rate) — `CLOSURE_DIAG`(`QUANTA_BENCH_CLOSURE_DIAG=1` → `closure-i-*.json`).
- **주의:** n=1 SWE A/B는 노이즈. 케이스 셋(baseline 실패 N개) + SERIAL 채점. 동시런 throttle = grader-invalid 측정구멍(제외분류).

### #2 — xarray val stall 원인 확정
- **기능:** 진행 중이던 xarray val(gpt-5.5) 런이 `lsp_references xarray/core/merge.py`에서 ~20분 stall. 원인 미확정.
- **[2026-06-28 update]** root cause found: xarray/box OOM(exit 137)은 **python-shim recursion으로 인한 `uv` fork-storm**. fix 작성 중(미검증/미커밋) — 아직 RESOLVED 아님, 그대로 둘 것.
- **왜:** OTEL sink가 run-id 미라벨([[jun-28-otel-sink-no-runid-attribution-gap]])이라 스팬 귀속 불가 + SSH 차단으로 operator-side만 봄. LSP-wedge vs 박스death 미구분.
- **how:** 박스 ground-truth 필요 — `ssh -i ~/Downloads/pickinstead_korea.pem ubuntu@<ip> 'tail -40 ~/run.log; ps aux|grep pyright'`. (SSH는 유저만 가능.)
- **ROI:** 중. fork-storm 가드(`d17757a82`) 들어갔으니 재현 시 더 깨끗이 보일 것.

### #3 — xarray 재던지기 (측정구멍 닫고)
- **기능:** fork-storm 가드 + `QUANTA_LSP_PREWARM=0`으로 xarray red 케이스 재시도.
- **왜:** xarray는 pyright OOM/wedge 상습(exitCode 247 / exit 137). 가드 들어갔으니 이제 진짜 측정 가능. never-solved 돌파 후보.
- **ROI:** 중.

### #4 — sticky-red robustness 굳히기
- **기능:** `agentless-v6-singlepass-execfull` + `QUANTA_BENCH_MUST_PASS=sticky` + gpt-5.4 로 django-11141 2~3회 더.
- **왜:** sticky-PASS(1334B 재합성, P2P 0/24)가 아직 **n=1**. "모델천장 아님·스캐폴드가 진범" 결론을 굳히려면 반복 필요([[jun-27-11141-model-gap-controlled]] line31).
- **ROI:** 중.

### #5 — (선택) OTEL sink run-id 라벨링
- **기능:** sink 라인에 resource attr(run-id/instance) 박거나 run당 sink 분리.
- **왜:** 멀티박스 캠페인에서 특정 run 진단 가능하게(이번 stall 진단을 막은 갭).
- **ROI:** 하 (관측성 북극성엔 부합하나 당장 블로커는 아님).

### #6 — (선택) driver-integration 테스트
- **기능:** driver의 repair-phase가 seam(`resolveRepairEvaluatePredicate`)을 우회하지 못하게 통합 테스트.
- **왜:** 현재 가드는 함수 단위 + DRY까지만. driver가 seam 안 쓰고 raw 넘기는 회귀는 못 잡음.
- **ROI:** 하 (회귀확률 이미 낮춤).

---

## 2. 핵심 config / 명령

```bash
# winning baseline (측정된 최고, gpt-5.5)
preset=agentless-v6-singlepass-execfull   # lsp/localize5/repro5/issue-hint/in-loop-exec=full

# closure A/B arms (마지막 2줄 노브만 차이)
agentless-v6-closure-control   #  + closure grounding, repair 루프 OFF
agentless-v6-closure-repair    #  + closure-repair:5 (재주입 루프 ON)
agentless-v6-closure-tuned     #  + closure-repair:5 + repair-spec-gate:1  ← 활성화한 #2

# sticky-red (11141 갭 닫음 — 모델천장 아니라 스캐폴드)
QUANTA_BENCH_MUST_PASS=sticky

# 진단 노브
QUANTA_BENCH_CLOSURE_DIAG=1          # closure-i-*.json (gate/repro metrics)
QUANTA_LSP_PREWARM=0                 # xarray pyright wedge 회피

# full-remote 채점 (정본 = 원격, docker 로컬 금지)
bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
  --dataset <jsonl> [--instance <id>] --preset <preset> --model <m> --allow-extra-boxes
```

**대시보드:** `bun run tools/leaderboard-dashboard/server.ts --port 7878` → http://localhost:7878
(REPORT_ROOTS에 SSOT `~/.quanta/bench/results` + full-remote `~/Library/quanta-codeagent-v3/bench` 물려있어 라이브 반영. trace 탭 :4318.)

---

## 3. 함정 / 제약 (꼭 읽을 것)

- **SSH 차단** — 박스 접속은 유저만. 정확한 명령 주고, echo에 ssh 문자열 넣지 말 것.
- **채점 SERIAL만** — 동시채점 = false-neg. 정본 = 원격 grade(로컬 docker 금지).
- **동시런 throttle** — 여러 full-remote 동시 = 429/grader-invalid 측정구멍. concurrency 낮게, 유저 라이브 런과 충돌 주의.
- **`git add -u` 금지** — explicit path 커밋. 병렬 에이전트가 동시 커밋함.
- **OTEL sink run-id 없음** — 멀티박스에서 스팬을 특정 run에 귀속 불가. run-귀속 ground-truth = run 전용 stdout 로그뿐.
- **모든 knob DEFAULT-OFF byte-identical** 하드 불변식 (guard 자동강제).
- **n=1 추론 금지** — measure-first, 결론 단정 전 카세트/trace 적대어딧.

---

## 4. 바로 집을 다음 수
**#1**: `closure-tuned` vs `closure-control` 좁은 A/B를 baseline 실패 케이스 셋에 던짐 (`CLOSURE_DIAG=1`, SERIAL, pre-flight 통과 후). 활성-#2가 control 넘으면 closure 작업 첫 net-positive 실측.
