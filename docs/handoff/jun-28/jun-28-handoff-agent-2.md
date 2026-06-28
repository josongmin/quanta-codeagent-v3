# jun-28 Handoff — agent-2 (stale execfull ❌ 원인규명 + 재측정 캠페인)

작성: 2026-06-28. 다음 에이전트가 바로 집을 수 있게 **남은 일 + 필요한 context**를 남김.
관련 메모리: `[[jun-28-closure-repair-false-green-root]]`, `[[jun-26-v6-singlepass-11138-winning-config]]`,
`[[jun-20-leaderboard-throttle-miss-confound]]`, `[[feedback-preflight-before-launch]]`,
`[[feedback-proactive-failure-alert]]`. 자매 문서: `jun-28-handoff-agent-1.md`.

---

## 0. 이번 세션에 한 것

### A. 대시보드 ❌ 8개("패치했는데 틀림") 원인규명 — **결론: 결과가 stale**
- 대상 8개: sympy-23413 / pylint-7080 / pylint-4970 / django-14376 / sympy-15976 (❌ 5),
  django-15554 / sympy-13091 / sympy-19040 (부분통과 3).
- ground-truth = `~/.quanta/bench/results/...report-i-*.json` (per-box patch-gen 리포트) 직접 파싱.
- **언제 돌린 거냐:** 전부 **6/27 05:20~13:05 KST** 오버나잇 unsolved-rerun 웨이브. gpt-5.5,
  `bench-in-loop-exec: full`(=execfull) 확정. 패치는 전부 **비어있지 않은 진짜 패치 + completed_unresolved**
  (bytes 1.5K~14K, error 없음) → "패치했는데 틀림" 라벨 맞음. **측정구멍 아님**.
  - 단 예외: django-14376 의 6/27 06:44Z(OAuth 토큰만료) + 06:45Z(LLM stream failed) 두 건은
    0바이트/turns=0 **측정구멍** → miss로 세면 안 됨. 실제 attempt는 12:01/12:04(791B) 쪽.
- **로직 수정 전/후?** → **전(前)**. preset 자체는 `b0049a5b7`(6/26 04:40 KST)에 생겨 런이 그 뒤지만,
  execfull이 의존하는 **in-loop 실행 로직**은 런 끝나고 **같은 날 저녁(~6h 뒤)에 통째로 갈아엎음**:
  - `1f1e8fda9`(6/27 18:48) django repro-bootstrap 수제 휴리스틱 제거
  - `bdab7f7ce`(6/27 19:32) + `ee35517f3`(6/27 20:22) per-(repo,version) spec SSOT + specRunnerKind
  - 6/28: `9b26a5f68`(closure readFile 버그), `27bdc62c1`/`7e36fe007`(repair spec-gate 활성·가드),
    `c1adcce12`(knob→AgentConfig SSOT)
  - ⇒ **이 ❌들은 삭제/교체된 옛 execfull 경로로 뽑힌 패치. 현재 로직 기준으로 무효라 재측정 필요.**
- 의심 원인(미확정, trajectory 필요): execfull in-loop 테스트가 그 당시 옛 부트스트랩으로 돌아
  **false-green**(약한 신호에 조기정지) — `[[jun-28-closure-repair-false-green-root]]`의 약한 predicate
  → over-narrow 패치 클래스와 동일 라인.

### B. 재측정 캠페인 발사 (진행 중)
- **범위:** ❌ 5개만 (유저 결정). **config:** `agentless-v6-singlepass-execfull` · gpt-5.5 ·
  `NONEMPTY_FALLBACK=1` = **옛 win config 동일조건** → 바뀐 건 6/27~28 로직 오버홀뿐 = 순수 before/after A/B.
- **발사 경로:** `tools/campaign-generic.sh` (execfull preset 하드코딩, `--allow-extra-boxes`=새 박스,
  self-terminate, green harvest). 호출:
  ```
  CNS=rm5 CQUEUE=/tmp/camp-rm5-queue.txt CMODEL=gpt-5.5 CMAXBOX=1 CBATCH=6 \
    nohup bash tools/campaign-generic.sh > /tmp/camp-rm5-supervisor.log 2>&1 &
  ```
- **왜 이 모양:** 유저 diag 런 3개가 라이브였음 → single-box 락 충돌 회피(`--allow-extra-boxes`),
  throttle 풋프린트 최소(MAXBOX=1, concurrency=1, 5개 한 박스 직렬). preflight PASS 확인 후 발사
  (`tools/bench-preflight.sh /tmp/remeasure5.jsonl gpt-5.5 agentless-v6-singlepass-execfull`).
- **현재 상태(작성 시점):** 박스 `i-0b506c67f5db00f2b`@3.37.87.221, bootstrap·pyright 1.1.411 통과,
  **1번째 django-14376 도는 중**, green 0, supervisor PID 살아있음. 나쁜 신호 0.

---

## 1. 남은 일 (우선순위순)

### #1 — rm5 재측정 결과 수확 + before/after 판정 ★최우선
- **기능:** 캠페인 완료 후 5개 resolved 결과를 옛 ❌(6/27 stale)와 비교.
- **어떻게 보냐:**
  - 진행: `tail /tmp/camp-rm5-progress.txt` / 박스로그 `tail /tmp/camp-rm5-b201.log`
  - 통과: `cat /tmp/camp-rm5-green.txt` (정본 = 박스로그 `■PASS/FAIL` dedup, **green-tally는 backup복원 오염 주의** — `[[jun-28-red-campaign-xarray-oom-and-tally-hygiene]]`)
  - watcher(`/tmp/camp-rm5-watch.sh`, bg id `bswu9xckk`)가 첫 나쁜신호(account-death/429/OOM/box-loss) or 완료에 깸.
- **readout:** resolved Δ. green이면 = 로직 오버홀(repro-bootstrap→spec SSOT)이 false-green 잡은 증거.
  여전히 ❌면 = 스캐폴드 천장 아니라 모델/synthesis 한계 쪽 → trajectory 까서 실패모드 분류.
- **주의:** n=1 SWE는 노이즈. green 0/5라고 바로 "효과없음" 결론 금지 — 패치 bytes/turns 변화부터 보고
  실패모드 이동 여부 확인(`[[jun-25-v5absorb-preset-and-first-measure]]` = resolved 0이어도 실패모드 근본이동이 신호).

### #2 — ❌ 잔존 케이스 trajectory 실패모드 확정
- **기능:** 재측정 후에도 틀린 케이스의 박스 trajectory(`bench-trajectory.jsonl`)를 까서
  localize-fail / synthesis-fail(맞는파일 틀린edit) / false-green 중 무엇인지 instance별 확정.
- **왜:** 지금 "false-green 의심"은 가설일 뿐. `[[no-inference-from-insufficient-evidence]]` — trajectory가 ground-truth.
- **ROI:** 중상. 다음 레버(오라클 강화 vs cross-vendor diversity) 방향 결정.

### #3 — 나머지 stale execfull 결과 전수 재측정 여부 판단
- **기능:** 이번 5개 외에도 6/27 웨이브의 execfull 결과는 전부 옛 로직 산출물. 대시보드 ❌/부분통과
  중 execfull로 측정된 것 다수가 stale.
- **왜:** 천장 판단을 옛 로직으로 하면 오판. 단 전수 재런은 비싸니 rm5 결과(=#1)로 ROI 먼저 가늠.
- **how:** stale 식별 = report timestamp 6/27 이전 + `bench-in-loop-exec:full`. `/tmp/probe.py` 패턴 재사용.

---

## 2. 함정 / 교훈 (이번 세션)
- **대시보드 preset 라벨은 인스턴스별 union** — 한 인스턴스에 여러 preset 런이 쌓여 보임
  (예: pylint-4970 = 6/20 v2/v3 런 + 6/27 execfull 런). "어느 런이 ❌냐"는 report-i-*.json timestamp로 격리.
- **per-box report 의 `resolved`=None** — 채점 별도라 그 파일엔 verdict 없음. "틀림"은 대시보드 채점본 기준.
- **발사 전 라이브 런 확인 필수** — `ps aux|grep "grade --mode full"` + `aws ec2 describe-instances`.
  유저 diag 3개 돌던 중이라 single-box 락/throttle 충돌 직전이었음. `--allow-extra-boxes`로만 회피.
- **`stat`/`python3`가 zsh for-loop 서브셸서 PATH 잃음** — 절대경로(`/usr/bin/python3`) or 스크립트 파일로.

---

## 3. 빠른 재진입 명령
```
# 캠페인 상태
cat /tmp/camp-rm5-progress.txt; cat /tmp/camp-rm5-green.txt
p=$(cat /tmp/camp-rm5-b201.pid); kill -0 $p && echo ALIVE || echo done
tail -30 /tmp/camp-rm5-b201.log

# 박스 ground-truth (유저 SSH)
ssh -i ~/Downloads/pickinstead_korea.pem ubuntu@3.37.87.221 'tail -40 ~/run.log'

# 원본 stale 결과 재조사
/usr/bin/python3 /tmp/probe.py   # report-i-*.json 에서 5개 instance 결과 덤프
```
