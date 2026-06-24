# 우리만 못 푼 3케이스 — 경쟁사 승리 trajectory 분석 (2026-06-24)

세 케이스 모두 `.tmp/bench-ouronly-visible-2026-06-21/three-confirmed-fails.jsonl` =
우리만 miss / 다른 submitter는 solve 기록 있음 (official Verified board 180 전수 확인).

trajectory는 swe-bench-submissions S3 공개버킷에서 받음. **실패 traj는 _FAILED-do-not-analyze/로 격리**
(Prometheus 13033, live-swe 13033 = traj 존재하지만 resolved=false. "traj있음≠solve" 함정).

## 케이스별 난이도 클래스 + 우리 실패 + 승자 기법

### django__django-14315 — DUAL-SITE 미묘 시맨틱
- bug: postgresql client가 empty `{}` 반환(should be None) → subprocess가 os.environ 상속 못함.
- gold: base/client.py(consumer) + postgresql/client.py(producer) **둘 다**.
- 우리: postgresql 한 곳만 (`if not env: env=None`). base/client.py 안 건드림 →
  tests/backends/base/test_client.py FAIL.
- 승자(OpenHands+DevStral, Qodo): **consumer(base/client.py)까지 localize**.
  - Qodo(전이가능): `git log <file>`로 도입커밋 bbe6fbb876 찾고 `subprocess.run(env=)` 시맨틱 추론
    → "base client fix가 핵심". sibling test dir(tests/backends/base/) 읽음.
  - OpenHands(전이불가, answer-key): `curl github PR 14315.diff`로 gold 두 파일 그대로 봄. ⚠️
- 레슨: 한 모듈이 반환한 값을 **다른 caller가 해석**하는 버그면 consumer도 localize.

### astropy__astropy-13033 — EXACT-MESSAGE 정확매칭
- task: 오해소지 ValueError 메시지 개선. gold = `as_scalar_or_list_str` 헬퍼로 **기존 메시지 템플릿** 수정.
- 우리: 테스트가 검사하는 기존 메시지 대신 **자작 "missing required column" 분기** 추가
  → 기대문자열 불일치 + pass_to_pass까지 깨뜨림(regression).
- 승자(Sonar): **fix 쓰기 전에** 테스트의 정확한 assert 리터럴부터 grep/read
  (`assert exc.value.args[0] == "...expected 'time' as the first column but found 'c'"`),
  repro로 어느 문자열이 틀린지 핀포인트 → 기존 템플릿만 수정.
- 레슨: 메시지/포맷 버그는 fix 전에 테스트 기대 리터럴부터 읽어라(sequencing).
- 데이터 한계: 13033 OSS 승자(mini-swe+Opus high)는 traj 미업로드. Sonar trace는 diagnosis phase까지만(truncated).

### django__django-11138 — WIDE COORDINATION (4파일)
- gold: mysql/oracle ops + sqlite3/base(등록함수 arity 2→3,3→4 bump) + sqlite3/operations(call site 전부).
  하나라도 빠지면 FAIL.
- 우리: **빈 패치**. 5745 이벤트 thrash 후 recovery→session_end abort(예산 소진).
- 승자(OpenHands/TRAE/live-swe/Prometheus 4팀 공통):
  - **진짜 실패테스트를 빠른 oracle로 루프에 박음.** TRAE: edit→`runtests timezones`→
    `sqlite3.OperationalError: wrong number of arguments` 런타임에러가 빠진 arity/call-site를
    그대로 지목 → "Oh I forgot to update function registrations" (~5 cycle). 정적추론으로 안 보이는
    coordination trap을 test runner가 드러냄.
  - **paired control로 무관실패 1-step 기각.** live-swe `git stash`→여전히 fail→"pre-existing,
    내 diff 아님". Prometheus regression baseline. 4팀 다 무관한 YAML serialization fail 만났는데
    승자는 한방에 pre-existing 증명(red herring 추격 안 함).
  - call-graph grep으로 breadth 선바운딩(`_convert_field_to_tz`/`CONVERT_TZ`/`create_function`).
  - 효율: TRAE 44턴(최소) — 까다로운 sqlite 사이트를 추론 대신 테스트에러로 찾아서.
- 레슨: 광역 refactor 실패↔성공 가른 건 **예산크기 아님**. early 실제-test-oracle + paired-control.

## 휴리스틱/답안지 vs 구조적 — 검증 분류 (curl/git grep으로 전수확인)
질문: 쟤네 휴리스틱/답안지로 조진거냐, 구조적으로 잘 조진거냐?
답: **1건(14315 OSS) 빼고 다 구조적·정당·전이가능. 휴리스틱(gold regex/경로/키워드 매칭) 0건.**
- ❌ ANSWER-KEY: **14315 OpenHands+DevStral** = `curl github.com/django/django/pull/14315.diff`(+.patch, api.github) 3회
  → 머지된 PR diff(=gold) 네트워크 fetch해서 베낌. "작은 DevStral가 hard case 풀었다"=가짜서사.
  전이금지(=우리 no-answer-key 규칙 위반). 14315 유일 OSS solve가 이거라 **clean OSS 레퍼런스 없음**.
- ✅ STRUCTURAL(curl 0):
  - 14315 Qodo: `git log/show bbe6fbb876`(버그 도입커밋, base_commit 기준 **과거만**)+subprocess(env=) 시맨틱 추론.
  - 13033 Sonar: 레포에 **원래 있던** 테스트 읽음(test_patch가 추가하는 2-col 케이스 아님; 헝크헤더상 단일col assert는 base_commit에 기존). 답안지 아님.
  - 11138 OpenHands/TRAE/live-swe: curl/git archaeology 0. call-graph grep+기존 test suite oracle+git stash control.
핵심: git archaeology는 **과거 히스토리만** 봄(fix커밋은 base_commit 이후라 레포에 없음)=정당. test_patch는 채점시 적용이라 base_commit 파일시스템에서 못 읽음=구조적 솔버는 답안지 접근 불가.

## 전이가능 방법론 (헝리스틱 아님, 일반 구조기법)
- **M1 버그-도입커밋 archaeology**: problem statement가 가리키는 도입커밋을 `git log/show`(과거만)로 까서
  회귀 형태+consumer 사이트 파악. [14315 Qodo] → dual-site 해결.
- **M2 기존 테스트 spec-read 선행**: fix 쓰기 전 레포의 기존 테스트에서 pinned 포맷/계약 읽고 거기 맞춤
  (자작 메시지 금지). [13033 Sonar] → exact-spec 해결.
- **M3 기존 test-suite를 일관성 oracle로**: 광역 edit 후 기존 스위트 실행→런타임에러(`wrong number of
  arguments`)가 빠진 arity/call-site를 지목. 정적추론 사각을 테스트가 드러냄. [11138 TRAE] → wide-coord 해결.
- **M4 paired-control(git stash)**: 무관한 pre-existing 실패를 1-step으로 기각(red-herring thrash 차단). [11138 live-swe]
- **M5 call-graph grep 선바운딩**: edit 전 blast radius를 grep으로 한정. [11138 공통]
이 5개는 gold/답안지 무관한 일반기법이라 흡수 OK. PR-fetch(M0)만 금지.

## 공통 root cause (우리 스캐폴드)
세 실패 다 하나로 수렴: **실제 실패테스트를 건 tight observe→edit→run-real-test→observe 루프 부재.**
- 13033: 실패테스트 기대문자열 먼저 안 읽음
- 14315: consumer/base 테스트로 안 번져나감
- 11138: 광역변경 수렴 oracle 없음 → 무한탐색 → abort
기존 메모리(repro-gen 45%실패, verify-and-select, repro-oracle 병목)와 정확히 같은 방향.

## absorb 후보 (ROI순)
1. **localize 단계에 failing-test 본문 강제주입 + "기대 리터럴 먼저 읽기" steer** (13033류, 저비용 고ROI).
2. **edit 후 실제 FAIL_TO_PASS 테스트 실행을 루프 oracle로 게이트**(11138류 wide-coordination 수렴신호).
3. **paired-control(git stash diff)로 pre-existing 실패 자동기각** → red-herring thrash 차단.
4. **consumer-localize steer**: 반환값 버그면 caller도 찾아라(14315 dual-site).
주의: OpenHands의 `curl PR.diff`는 answer-key leak(전이 금지). 전이가능한 건 git log/semantics 추론.
