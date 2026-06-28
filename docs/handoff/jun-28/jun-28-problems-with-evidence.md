# jun-28 — 문제점 전수 (증거·위치 포함)

작성 2026-06-28. rm5 재측정 + ungraded 재채점 세션서 드러난 문제 전수. 각 항목 = 문제 / 증거(raw) / 위치 / 함의.
관련: `[[jun-28-synthesis-localize-recovery-plan]]` `[[jun-20-leaderboard-throttle-miss-confound]]` `[[feedback-bg-launch-supervisor-not-nohup]]` `[[swebench-arm64-grading-recipe]]`

---

## 🔴 A. 채점 인프라 (gap 숫자를 거짓으로 만듦 — 최우선)

> ⚠️ A1~A3 ROOT CAUSE 확정 (코드 추적, 2026-06-28): "미스터리"가 아니라 **AMI가 django 이미지만 pre-pull + 내가 cold-image 안전 기본값(mw4) 무시하고 mw16 박음 + 디스크 포화**. 아래 각 항에 반영.

### A1. 채점 non-deterministic (같은 patch가 런마다 다른 verdict)
- **증거**: ungraded 28개 재채점서 `pallets__flask-5014`가 retry1=✅resolved → retry2=⚠️error. django-11477 등도 한 리포트선 completed-unresolved, 다른 리포트선 error.
- **위치**: `/tmp/regrade-out/quanta-regrade.regrade-h1.json` vs `...regrade2-h*.json` 비교.
- **ROOT CAUSE**: flaky 자체가 독립 문제가 아니라 **A3의 cold-image pull 경합/디스크 압박의 증상**. warm image(django)는 deterministic, cold(matplotlib/flask)는 pull race로 resolved↔error. 디스크 여유 + warm image면 사라짐.
- **함의**: determinism은 **warm image + 충분 디스크 + mw 적정** 전제. 그 전엔 cold-repo verdict 신뢰 불가.

### A2. max-workers 높이면 채점 붕괴 (내 실수 — 문서화된 안전값 무시)
- **증거**: mw=16 → 28개 중 **resolved 0 / unresolved 5 / error 23**. mw=4로 낮추니 error 23→11. (`/tmp/regrade-holes.log`, `/tmp/regrade-holes2.log`)
- **ROOT CAUSE (코드)**: `src/apps/bench/remote/backend.ts:24` — `max_workers` 기본 **4**, 주석 그대로 *"cold-image docker-socket saturation safety"*. 내가 `--max-workers 16` 오버라이드 = **cold image(AMI에 없는 repo)를 16개 동시 docker pull/build → socket/디스크 포화**. warm image(django)는 16서도 멀쩡 = 그래서 repo-correlated.
- **위치**: 호출 `src/apps/bench/cli.ts` `cmdGrade`(~1819), `--max-workers` 파싱(:271,:290), 기본값 `backend.ts:24`.
- **함의**: cold image엔 기본 4 지켜라(또는 더 낮게). memory `[[jun-19-swebench-concurrent-grading-falseneg]]`("채점 SERIAL")는 cold-image일 때 특히.

### A3. matplotlib/sphinx/seaborn 채점 불가 — AMI가 django 이미지만 pre-pull
- **증거**: error 11개 **100% repo-correlated** — matplotlib 7 + sphinx 3 + seaborn 1 전부 error, django 13/pytest 2/sympy 1 전부 채점됨. matplotlib `run_instance.log` 안 생김(=테스트 전 image 단계서 죽음).
- **ROOT CAUSE (코드)**: `src/apps/bench/remote/ec2.ts:61-62` — 프리베이크 AMI = *"84 easy-django swebench EVAL images pre-pulled"*. **django만 warm**. 비-django는 cold → 그 자리서 `--namespace swebench` pull 필요(grade-only도 namespace 씀: `ssh.ts:80-85`, ec2가 ssh builder 재사용). 근데 AMI 디스크가 이미 84 django 이미지로 차있고 mw16 동시 pull → 디스크/socket 포화 → error.
- **위치**: AMI 이미지셋 `src/apps/bench/remote/ec2.ts:61`(bake-ami.sh), grade script `src/apps/bench/remote/ssh.ts:80`(`--namespace swebench --cache_level instance`), `/tmp/regrade-out/*.json` `error_ids`.
- **함의**: namespace 누락 아님(이미 있음). 비-django 채점하려면 (a) AMI에 그 이미지 bake 확장(ec2.ts:61 bake-ami.sh) or (b) 디스크 키우고 mw 낮춰 serial pull. 현 AMI론 django-family만 신뢰. = capability 아닌 **AMI 커버리지** 문제.

### A4. ungraded 31개 (진짜 patch인데 채점 미완)
- **증거**: 전수 audit(257 instance, latest dedup): `MEAS:ungraded 31` = passed≠true + gradeBreakdown=None + patchBytes>0(637~3594B) + error없음. django-11728/11734/12308/16256 + matplotlib 6 등.
- **위치**: `~/.quanta/bench/results/*.json` perInstance에서 `gradeBreakdown===None`.
- **함의**: 대시보드 gap에 "miss"로 섞임. 실은 "채점 안 됨". 재채점(A1~A3 때문에) 깨끗이 못 닫음.

### A5. stale-execfull 오염
- **증거**: rm5 5케이스 6/27 결과가 6/27~28 로직 오버홀(repro-bootstrap→spec SSOT, 커밋 1f1e8fda9/bdab7f7ce/ee35517f3) **이전** 산출물. baseline 재측정 5/5 FAIL이 옛 결과와 patch bytes 동일(14376=791B).
- **위치**: `[[jun-28-handoff-agent-2.md]]` §0-A 타임라인.
- **함의**: gap 천장 판단에 옛 로직 결과 섞임. report timestamp + `bench-in-loop-exec:full`로 stale 식별 필요.

---

## 🔴 B. 런타임 인프라 (런이 죽거나 $ 샘)

### B1. nohup 백그라운드 ~15-20분 reap → 박스 orphan
- **증거**: sticky-serial(PID 9436), 14376-RCA(4726) 등 plain `nohup bun &`가 15-24분서 사라짐. 박스는 `state=running`인데 로컬 grade 프로세스 0(=poller reap). i-03b81a 등 orphan.
- **위치**: `[[feedback-bg-launch-supervisor-not-nohup]]`(메모리 박음). campaign-generic.sh supervisor는 생존.
- **함의**: 장시간 런은 supervisor 필수. macOS엔 setsid 없음.

### B2. spot reclaim 재발사 (작업 손실)
- **증거**: sticky-parallel "⚠️ 5/5 instance(s) lost (spot reclaim/ssh-255) — relaunching attempt 2/2". ~20분치 날리고 재시작.
- **위치**: `/tmp/sticky-arm5-par-*.log`; 코드 경로는 `src/apps/bench/remote/full.ts` spot/ssh-255 requeue 문구, `src/apps/bench/remote/box-session/detached-poll.ts` box-death 판정.
- **함의**: spot은 비용상 유리하지만 중간 reclaim시 work loss가 생김. 긴 채점/patch-gen은 resume artifact 없으면 capability 측정도 비용도 동시에 오염.

### B3. orphan/정체불명 박스 누적
- **증거**: 한때 running 6개 중 val-xarray 3개(04:04/04:25/04:48) 정체불명, diag3 wedge.
- **위치**: `aws ec2 describe-instances --filters state=running` 결과와 로컬 `ps aux|grep "grade --mode full"` 교집합 없음. 관련 재진입 포인터는 `jun-28-handoff-agent-2.md` 발사 전 라이브 런 확인 항목.
- **함의**: 비용 누수. `aws describe state=running` ∩ 로컬 grade프로세스 없음 = orphan.

---

## 🔴 C. 측정 confound 분류 (실패를 잘못 셈)

### C1. grader_invalid를 회귀/miss로 뭉갬
- **증거**: astropy-7606/8707/8872가 `scoreLabel/error`에 grader 아티팩트 있는데 일부 분석서 "회귀(p2p>0)"로 셈. 내 audit선 `MEAS:err`로 재분류.
- **위치**: `src/runner/batch/eval/run-health.ts` 분류 + report `gradeBreakdown`.

### C2. throttle를 stall로 (일부 봉합됨)
- **증거**: run-health가 429/throttle를 비-abort `empty_or_stall`로. 이번 세션 `transient_throttle` 추가(`3cec24c22`)로 일부 봉합.
- **위치**: `src/runner/batch/eval/run-health.ts` THROTTLE_PATTERNS.

---

## 🟡 D. RCA 프로세스 실책 (성급 단정 — 매번 정정됨)

### D1. 14376 gold 파일 오판
- **틀림**: "gold=base.py+connection.py" → **맞음=base.py+client.py**. connection.py는 sticky가 만진 오답 파일.
- **증거**: `python3 -c "...re.findall('\\+\\+\\+ b/',patch)"` on `/tmp/camp-rm5-b201.jsonl` → `['mysql/base.py','mysql/client.py']`. 원인=40자 truncate 문자열 비교.
- **위치**: gold=`/tmp/camp-rm5-b201.jsonl`; 정정 요약=`jun-28-synthesis-localize-recovery-plan.md` 0번 표 django-14376.
- **함의**: truncate된 파일명/patch preview로 gold 대조하면 edit-site RCA가 뒤집힘. full patch path 추출만 정본.

### D2. "trajectory 없음" 오판
- **틀림**: "per-turn 카세트 없어 세부 RCA 불가" → **있었음**. `trajectory-i-0b506c....jsonl`(17MB)·`-077a01....jsonl`(33MB), 5케이스 per-turn 다 포함. 원인=box-id 이름 파일을 instance-name으로 grep.
- **위치**: `~/Library/quanta-codeagent-v3/bench/full-remote/trajectory-i-0b506c*.jsonl`, `...trajectory-i-077a01*.jsonl`; fetch 경로는 `src/apps/bench/remote/box-session.ts` trajectory artifact save.
- **함의**: 파일명 규칙을 모르면 RCA가 "증거 없음"으로 거짓 종료됨. report suffix/box id 기준으로 artifact를 찾아야 함.

### D3. "pure synthesis" 과단순
- **틀림**: 4970/7080/23413을 "순수 synthesis"로 → repro oracle 부재(`installed=false`) confound 동반.
- **증거**: report reproTest `installed=false reason=no_reproduced_candidate/execution_failed`.
- **위치**: baseline/sticky report=`~/Library/quanta-codeagent-v3/bench/full-remote/report-i-*.json`; 정정 요약=`jun-28-synthesis-localize-recovery-plan.md` 0번 표.
- **함의**: synthesis 레버만 추가하면 weak-oracle 위 blind search가 됨. canonical repro persistence/fail-closed가 Phase 1 선결.

### D4. grep/process 오판 반복 ("박스 죽었다" 헛알람)
- **틀림**: `pgrep -af|grep -v grep` 출력 mangle로 "NONE alive"/"dead" 여러 번 오판. 실제 `ps -p <pid>`로 보면 살아있었음.
- **증거**: plain grep pipeline 출력과 `ps -p <pid>` 결과 불일치. 이후 campaign supervisor PID 확인은 `kill -0 $(cat /tmp/camp-rm5-b201.pid)` / `ps -p <pid>`로 정정.
- **위치**: 재진입 명령=`jun-28-handoff-agent-2.md` §3 빠른 재진입 명령.
- **함의**: long-run 상태는 grep pipeline이 아니라 pidfile+`ps -p`+박스로그 tail을 정본으로 둬야 함. 아니면 살아있는 런을 죽은 런으로 오판해 중복 발사/박스 누수가 남.

---

## 🟢 E. 진짜 capability 갭 (타겟)

### E1. synthesis 74% (자리맞고 답틀림)
- **증거**: 전수 audit `SYNTHESIS(f2p>0,p2p0)=76`. rm5 5케이스 gold-vs-ours: 23413 over-eng(rank/flag/restore 덧댐 vs gold=loop cap 치환), 4970/15976 wrong synthesis, 14376 multi-site(client.py 누락), 7080 one-hop localize 실패. 경쟁사 22-27/134 풂(천장 아님).
- **위치**: gold=`/tmp/camp-rm5-b201.jsonl`, ours=`preds-i-*.jsonl`, oracle md=`docs/analysis/swe-bench-verified-analysis/<repo>/<id>.md`.
- **레버**: `[[jun-28-synthesis-localize-recovery-plan]]` — oracle-first → evidence-expander → patch-reduction.

---

## 한 줄 결론
gap "61"의 절반 이상이 **측정·채점 인프라 구멍**(A: 채점 flaky/불가, ungraded, stale)이라 **정확한 capability 숫자조차 못 냄**. 진짜 갭은 synthesis(E1)지만, **다음 1순위는 레버 추가가 아니라 결정적 채점(serial+prebuilt-image) + persistence**(A1~A4 선결). 안 그러면 어떤 레버를 넣어도 flaky oracle 위 blind.
