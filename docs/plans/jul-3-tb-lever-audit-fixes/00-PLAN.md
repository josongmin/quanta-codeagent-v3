# jul-3 TB-레버 어딧 수정 플랜 (2바퀴 어딧 결과 → 3바퀴+헬게이트)

> 출처: 사용자 제공 2-round 어딧(TB 레버 스택: owned/verify-gate/OC1/timeout/cassette/dashboard — 이번 세션 산출물). **전략어딧 14건(별 워크스트림, docs/plans/jul-3-strategy-audit-fixes)과 구분.** 이 문서 = 3번째 적대어딧 대상 + 헬게이트 실행 트래커.

## 원어딧 verdict 교정 (2바퀴서 뒤집힘/커짐)
- **B1(timeout)**: `TERMINAL_BRAIN_IDLE_TIMEOUT_MS=60s`는 brain-mode.ts:343-346 **no-op 스텁**(코멘트가 거짓서술). 실 바운드=harbor 1200s AgentTimeoutError뿐. IPC 경로선 partial 반환 픽션(hands가 cancel시 error만). 스탠드얼론 docker는 이미 60s 사일런트 킬(docker-run.ts:66, 타임아웃/정상 구분불가).
- **A2(no-leak 비대칭)**: 원어딧보다 큼. `isExerciseCommand`에 test-path 로직 0줄 → pytest /tests/x.py·bare pytest·/tests/verify.sh 전부 exercise=TRUE. best-of-n.ts:18-21 doc 거짓, verify-gate.test.ts:293이 오동작을 의도로 핀. 블라스트=best-of-N tie-break를 hidden-verifier 난타로 뒤집기 가능·OC1 다운그레이드. verified-pass는 L1 가드로 여전히 도달불가(예외: `cp /tests/expected ref && diff` 세탁). **신규 자기모순**: REFERENCE_HINT는 expected_output/golden 축복 vs TEST_PATH_MARKERS는 금지 → `diff mine.csv expected_output.csv`(태스크제공 페어) 오늘 거부 = verify-gate 자체 버그.
- **D1(crash 오집계)**: fix가 공짜. harbor result.json에 `exception_info`(132중 6 non-null, AgentTimeoutError 실물)+`agent_result.metadata`(브레인 report 전체)가 이미 있음. scanHarborTree가 읽고 duration만 남기고 버림. metadata-absent ⊂ exception(5/5) = 인트리 분류 완비, box불필요.
- **A3(exitCode 3-fix)**: static 맞으나 **wiring 증명 0**. exitCode 체인(tool.ts→execute.ts:278→stream→verify-gate) 테스트 0. resultRanClean이 exitCode:undefined를 clean(fail-open) → 배선 끊기면 crash 클래스 rubber-stamp. 기존 crash 픽스처는 ok:false인데 실툴은 non-zero에 ok:true+exitCode:2 → exitCode 체크 삭제 mutation이 현 스위트 통과.

## R2 신규 (원어딧 사각 — server.ts +213줄/신규파일, 내 세션 작업)
- arm 오분류: server.ts:1603 `preset.indexOf("levers")` → oc1 emit이 baseline arm에 = knob-off 컨트롤 오염.
- 메트릭 3중 불일치: TB✅=any-pass(dedup×runs×baseline∪levers 투영) vs 경쟁사=trial-avg vs 스모크 res()=first-trial → variance서 체계 낙관.
- **compactTrajectory가 assistant text 버림**: `kind:"text"` 데드코드 = cassette(fake-green RCA) 반쪽. (내 카세트 코드 버그)
- brain-mode.test 8 RED(memory-consolidator가 FakeLlm 스크립트 삼킴, pre-existing) = 레버#1/#2 회귀펜스 무방비.
- 그 외: TB검색박스 포커스 사망, pro/live 셀렉터 verified 오표기, tb-pertask.md 부재시 전 런 미표시(코멘트 거짓), tb-report-emit --model 없으면 gpt-5.5 날조(record-winning-config 위반), dedup fastest-FAIL 선호(25s crash가 20분 시도 이김), 스모크↔md 드리프트.

## 실행 플랜 (우선순위·기능+왜+ROI)

### P0 — 점수 직결
- **C1 owned 디폴트-ON(터미널 한정)**: `!gateDisabled(env, TB_ENV_OWNED_ENV)` (SSOT falsy셋, resolveTrajectoryOn 클론금지-"no"빠짐). 동반 5수술: RED전환 3(brain-mode.test:399,421, surface-profile-brain:171)+대조 2를 "0"arm(동어반복방지)+knob-inventory extra.ts:608-617 수동가드+스모크 baseline에 =0 export+line-31 에코. 시퀀싱: jul-3 레버회귀 3태스크는 all-ON 번들이라 OWNED 무죄 미확정 → **cassette 켜고 owned-only 3태스크 위트니스 런 1회로 귀속 확인 후 flip**. ROI=검증된 +4/5 레버 디폴트 회수.
- **B1 timeoutMs opt-in(디폴트 킬 금지)**: 캡 600s(CC 전례). IPC=호스트 합성(resolve+pending삭제+cancel프레임+failure.mode:"timeout"; late-frame drop 안전확인). docker=기존 60s 사일런트 킬을 typed timeout 승격(SpawnPort 레이어). 가이드 long-build 이스케이프 1줄. verify-gate: timedOut을 L1 observed서 제외. 디폴트 킬은 bg/await 시설 없인 금지(compile-compcert 100%태스크 죽임). ROI=hang-burn 차단, 회귀0(순수 opt-in).

### P1 — 측정 무결성 (의사결정 레일)
- **D1 crash 분류**: scanHarborTree가 exception_info+metadata 파싱→perInstance.error(agent-timeout/agent-crash, jun-20 real_attempt 전례). 타임아웃=진짜miss, auth-crash(metadata absent+단명)=infra. ROI=디플레이션 제거, 공짜.
- **arm 명시화**: tb-report-emit --arm 플래그→server.ts exact 매칭. ROI=A/B 오염차단.
- **OC1 fail-open+배선증명**: 실shape 픽스처(ok:true,exitCode:2)+real dispatch 관통 wiring(red-on-injection)+resultRanClean을 container_exec 한해 exitCode===0 fail-closed+decideGateFollowup 미커버 4콤보(특히 F,T,T). ROI=crash레버 생존보증.
- **RED 8 수복(FakeLlm↔memory-consolidator)**: 회귀펜스 복원. 이거 전엔 어떤 레버변경도 무펜스.
- **compactTrajectory text 배선**: 데드 kind:"text" 처리. ROI=fake-green RCA 완성.

### P2 — verify-gate 정합 (재설계+RED세트)
- **A2 재설계**: (i)러너-스코프 거부(pytest/tox/nose가 bare거나 test-path arg면 refuse, `python -m pytest` 포함); (ii)TEST_PATH_MARKERS를 경로마커(tests/·private/·verifier/grader)와 이름마커(answer/solution/golden/expected_output) 분리 — comparator operand는 경로마커만(자기모순해소), 이름마커는 exercise분류 불사용(./solution.py over-block방지); (iii)best-of-n doc을 (i)로 참되게 후 갱신; (iv)cp/symlink 세탁은 이름가드 한계로 명시(provenance=별RFC). 박스검증 후 land.
- **A1 SSOT수치**: best-of-n.ts 전제 66/11/12%→100/100/73%, 타겟을 진짜variance(train-fasttext13/make-doom17/filter-js20/raman43/sam-cell50)로 재조준. 문서만.
- **메트릭 라벨 통일**: TB✅=any-pass@k, 경쟁사=trial-avg, 스모크 res()=any-pass. ROI=낙관편향 오독방지.

### P3 — 도구 확장 (default-OFF knob+스모크 A/B)
- **B2 write 도구**: base64-over-exec `container_write_file`(heredoc mangle제거), manifest+드리프트가드, QUANTA_TB_WRITE_TOOL OFF. ROI=polyglot/code-from-image, A/B증명후.
- **B3 stream cap env-tunable**: 기본8K, levers arm 32K(pty_read 32K 전례).
- **server.ts UX 3**(포커스/pro-live/md침묵)+tb-report-emit model날조제거+dedup fastest-FAIL 수정.

## 집계
원어딧11: CONFIRMED7(A2·D1·B1 내용수정), 완화오류1(A2), fix쉬워짐1(D1), LOW4 재확인. R2신규10.

## 실행 순서 (이 트래커 기준)
0. 전략어딧 14건 먼저 랜딩(별 워크스트림) → 그 다음 이 P0-P3.
1. 3번째 적대어딧(이 플랜 대상) → 하드닝.
2. 헬게이트 P0→P1→P2→P3, 각 단계 로컬+오리진메인 커밋.

## 랜딩 상태 (jul-3 밤샘)
전략어딧 14건 + readSite 15 → `ea787de4a`. TB-레버 3rd어딧 하드닝 후 default-safe 랜딩:
- ✅ **P1-B/P1-C/P3-A/P1-F** (dashboard) → `0dfcc5932`: crash 분류(exception_info→perInstance.error, denominator 제외)·명시 --arm·model 날조제거·dedup(FAIL은 longer 우선).
- ✅ **P1-A wire + P3-C** (container-exec) → `271f2303e`: exitCode evidence red-on-injection 테스트·stream cap env-tunable(QUANTA_TB_STREAM_CAP, clamp[1024,32768]).
- ✅ **P2-A/P2-B/P1-A/P1-E/P0-B** (terminal) → `77f391f96`: 마커셋 분리(name-heuristic 제거, /tests/ 유지)·test-runner exercise 제외(pytest/-m pytest)·resultRanClean container_exec fail-closed·real-shape 크래시 픽스처·compactTrajectory text 코얼레서·idle-stub 삭제.
- ✅ RED-8 이미 랜딩(brain-mode.ts memoryAuto QUANTA_MEMORY_AUTO=0), 26/26 green.

### 보류/후속 (box-gated or 별 hellgate)
- ⛔ **C1 owned-default-ON**: BLOCKED — witness런(cassette-on owned-ONLY 3태스크: extract-elf/path-tracing/headless-terminal) 미기록 + smoke baseline `=0` confound-fix가 flip과 atomic이어야. witness가 owned 무죄 확인해야 flip. 유일한 agent-behavior 변경.
- ⬜ **B1-core timeoutMs opt-in**: 미구현(순수 opt-in, default kill 금지, SpawnPort에 param 스레딩). idle-stub만 삭제됨.
- ⬜ **B1-docker typed timeout**: measure-first 별 커밋(60s 사일런트 킬 승격 + 값 param화).
- ⬜ **P3-B container_write_file**(QUANTA_TB_WRITE_TOOL): 별 hellgate(manifest 등록+드리프트가드+HARD_DENY 경로스크린).
- ⬜ **P3-D** 잔여 UX(포커스/pro-live 라벨): cosmetic.
- ⬜ cp/symlink 세탁(A2 no-leak 한계): provenance RFC 별도.
