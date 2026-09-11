# TVH-13 — memory/output/temp-disk resource envelope

- 우선순위: P0/P1
- 상태: OPEN
- 소유 lane: shard admission / telemetry / output retention
- 선행: TVH-04, TVH-05
- 후속: TVH-09, TVH-10

## 확정 결함

1. `run-test-shards.ts:442-460`은 worker tree RSS를 15초마다 표본화할 뿐 admission/throttle/kill에 사용하지 않는다. 짧은 peak는 관측되지 않을 수 있다.
2. `run-test-shards.ts:398-495`의 chunk spool은 크기 상한과 free-disk preflight가 없다. 파일 증가를 progress로 보므로 무한 출력 child는 inactivity watchdog을 계속 회피한다.
3. timeout 진단과 정상 종료 모두 spool 전체를 `readFileSync(..., "utf8")`로 메모리에 올린다. 큰 worker 로그가 runner RSS를 다시 급등시킨다.
4. `delta-token-identity-hellgate`는 50M-character string을 만들고 다섯 번 full estimate한다. notebook tests는 200k cells, 50k×2k outputs, multi-MB image chunks를 만든다.
5. 이 대형 fixture들은 resource classifier에서 대부분 `pure`라 8-wide intra-worker와 다른 memory-heavy 파일이 동시에 실행될 수 있다.
6. ignored tool scratch에는 size/TTL owner가 없고 현재 workspace에 132MiB가 남아 있다. 이는 HEAD 결함 자체는 아니지만 cleanup과 일부 filesystem 도구가 ambient temp corpus를 만나므로 temp retention/admission 계약이 필요하다.
7. shadow matrix artifact는 plan+44 worker receipt/JUnit+aggregate에 explicit retention이 없어 storage retention과 upload bytes가 repository default에 맡겨져 있다.
8. RSS/watchdog/drain의 `ps` snapshot은 호출 횟수와 timeout budget이 resource envelope에 없고 slow cleanup에서 group당 약 1,400개 process spawn으로 FD/PID pressure를 더할 수 있다.
9. 추가 ordinary `pure` fixtures에 40×4MiB inflate corpus, 33MiB Uint8Array+Buffer/deflate, 5MiB boundary arrays가 있다. file-local child executor도 최대 4개 CLI process를 동시에 열지만 scheduler는 파일 claim 하나만 본다.
10. expired shard receipt GC는 total success 뒤에만 실행돼 red branch가 반복되면 prior successful chunk의 expired JUnit/scan payload가 누적된다.

## 구현

- test policy/telemetry에 `predictedP95Ms`, `predictedPeakRssBytes`, `maxOutputBytes`, `maxTempBytes`, `cpuWeight`를 둔다.
- dispatch는 현재 available memory/disk와 실행 중 reservation 합계를 원자적으로 비교한다. unknown weight는 작은 값이 아니라 exclusive fallback이다.
- RSS는 platform adapter로 더 자주/저비용 측정하고 soft limit에서 새 dispatch를 멈추며 hard limit에서 해당 process group을 typed resource-exhausted로 종료한다.
- spool은 bounded ring/head+tail 또는 chunked file retention을 사용한다. JUnit/scan receipt 파서는 stdout 전체 문자열 대신 독립 artifact/stream parser를 소비한다.
- output growth는 liveness 증거가 아니다. heartbeat/readiness channel과 실제 test-case completion을 progress authority로 사용한다.
- temp root 생성 전 free-space floor를 확인하고 worker별 quota/peak를 기록한다. quota 초과 시 다른 chunk를 오염시키기 전에 중단한다.
- repository 내부 ignored temp namespace는 producer ID, owner PID/start time, TTL, byte ceiling을 기록한다. 자동 GC는 해당 schema로 소유가 증명된 expired artifact만 제거하고 foreign/user scratch는 보고만 한다.
- hosted artifact에도 per-kind byte ceiling과 explicit retention을 두고 detailed worker output은 short-lived, aggregate evidence만 closeout 기간 보존한다.
- cache maintenance는 campaign verdict와 분리된 bounded lifecycle로 수행하며 failure/cancel에서도 expired owned payload를 정리하되 live writer와 foreign namespace를 보존한다.
- process observer는 snapshot 호출 budget과 timeout을 가지며 하나의 snapshot을 RSS/identity/drain 소비자가 공유한다.
- claim에 `maxChildProcesses`와 file-local memory/cpu multiplicity를 포함하고 test helper의 local concurrency를 runner permit에 연결한다.
- 대형 allocation test는 TVH-08의 PR canary/nightly split과 연결하고 최소 재현 크기 및 complexity slope를 측정한다.

## red-on-injection

- 1GB 무한 출력 child가 spool limit 내에서 종료되고 runner RSS/disk가 상한을 넘지 않는다.
- stdout을 계속 쓰지만 case가 진행되지 않는 child가 total wall deadline으로 종료된다.
- memory-heavy 두 chunk를 동시에 enqueue해도 reservation 합계가 budget을 넘지 않는다.
- 15초 미만 RSS spike가 telemetry 또는 hard-limit rail에 잡힌다.
- low-disk fixture에서 test process spawn 전에 typed admission failure가 난다.
- expired owned scratch와 foreign scratch를 함께 주입하면 owned artifact만 GC 후보가 되고 foreign path는 삭제되지 않는다.
- host budget=2에서 내부 cap=4 파일을 실행해도 active child peak가 2 이하이며 memory-heavy 두 파일이 동시에 dispatch되지 않는다.
- one-entry boundary canary와 nightly cumulative inflate의 exact case union이 기존 coverage를 보존하고 peak RSS가 각각 선언 budget 안이다.
- 연속 failed campaigns에서도 cache bytes/file count가 ceiling 아래이며 active sibling receipt는 삭제되지 않는다.

## 완료 기준

- [ ] output 증가만으로 hang이 무기한 생존하지 않는다.
- [ ] spool 전체를 runner memory에 다시 적재하지 않는다.
- [ ] CPU/time뿐 아니라 RSS/temp/output가 scheduler의 실제 입력이다.
- [ ] resource exhaustion 결과가 일반 assertion failure와 구분된다.

## 진행 (2026-09-12)

- **LANDED `c1a87073d`** — 확정 결함 2·3.
  watchdog이 `spoolBytes !== lastSpoolBytes → progressed` 한 줄로 liveness를 판정했다.
  어떤 바이트든 쓰이면 12분 inactivity 타이머가 리셋되므로 `console.log` 루프에 빠진 워커가
  **가장 살아있는 것으로 측정**되어 JOB timeout까지 간다(= watchdog이 지키려던 바로 그 외곽 경계).
  total wall bound는 아예 없었다.
  이제 3중 bound + typed outcome이고, **절대 bound 2개를 progress 휴리스틱보다 먼저** 평가한다
  (결함의 본질이 bound를 무효화할 수 있는 휴리스틱이었다):
  inactivity 12분 / total wall 40분 / output cap 512MiB.
  또한 timeout 진단과 정상 종료가 둘 다 `readFileSync(spool,"utf8")`로 **전체를 메모리에 적재**했다.
  runner 자신의 RSS가 보호 대상인데 병리적 producer에 대한 대응이 그 산출물 전량 적재였다.
  이제 파일 끝에서 bounded window만 positional read하고, 초과 시 그 사실과 전체 경로를 출력한다.
- 뮤턴트 4개 전부 killed.

### 남은 항목
- RSS soft/hard limit을 admission에 연결, temp disk free-space preflight,
  predicted peak RSS/output/temp를 scheduler 입력으로, owned scratch TTL/GC.
