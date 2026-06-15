---
instance_id: django__django-14011
repo: django/django
base_commit: e4430f22c8e3d29ce5d9d0263fba57121938d06d
version: 4.0
difficulty: 1-4 hours
created_at: 2021-02-15T06:15:21Z
fail_to_pass: 17
pass_to_pass: 2
gold_files: [django/core/servers/basehttp.py, django/db/backends/sqlite3/features.py]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro, overfit-risk]
---

# django__django-14011

## 문제 요약
`LiveServerTestCase`가 사용하는 `ThreadedWSGIServer`가 요청마다 새 스레드를 띄우지만, 그 요청 워커 스레드들이 종료될 때 자기 DB 커넥션을 닫지 않는다. 그 결과 테스트 종료 시 `destroy_test_db()`가 호출되면 `OperationalError: database "test_myapp" is being accessed by other users`가 절반 정도 확률로 발생한다(레이스 컨디션). 사용자는 1.11에서 #22414로 고쳐졌던 동작(요청 처리 후 커넥션 close)이 2.2의 스레딩 도입(#20238, `WSGIServer`→`ThreadedWSGIServer` 전환)으로 회귀했다고, CPython `socketserver.ThreadingMixIn` 소스까지 인용하며 보고했다.

## 유형 (정형화)

- **L (Localization) = L3 (Multi-site).** problem_statement/hints가 `ThreadedWSGIServer`, `close_request`를 핀포인트(표면적으로는 L0)로 짚어주지만, **올바른** 픽스는 한 곳이 아니라 ≥3 사이트가 **함께** 바뀌어야 한다: (1) `core/servers/basehttp.py`의 `ThreadedWSGIServer`에 커넥션 주입/정리 라이프사이클, (2) `test/testcases.py`의 `LiveServerThread._create_server`/`setUpClass`에 `connections_override` 배선, (3) `db/backends/sqlite3/features.py`의 skip-list. 한 줄 close만 추가하면 in-memory sqlite가 깨진다 → 진짜 좌표는 분산·조율형이라 L3.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning).** 픽스가 "체크 한 줄 추가"가 아니라 **작은 구조 변경**이다: 생성자에 `connections_override` 파라미터 도입, `process_request_thread`/`close_request`/`_close_connections` 라이프사이클 메서드 오버라이드, "부모 스레드에서 커넥션을 모아 자식 스레드에 주입(collect-then-inject)" 패턴 도입. 보조로 S2 — sqlite in-memory에서만 thread-sharing 주입이 필요하다는 **조건/불변식 추론**(`conn.vendor == 'sqlite' and conn.is_in_memory_db()`)이 들어간다. 이게 S1(템플릿) 아닌 이유: 정형 결함클래스(None가드/off-by-one) 매칭이 아니라 스레드 라이프사이클 재배치가 본질이기 때문.
- **K (Knowledge) = K-Domain.** django의 DB 커넥션 thread-shareability(`inc_thread_sharing`/`dec_thread_sharing`), thread-local `connections` 핸들러, in-memory sqlite는 thread당 별도 DB라 부모 커넥션을 명시 공유해야 한다는 사실, 그리고 CPython `ThreadingMixIn`의 `process_request_thread`→`shutdown_request`→`close_request` 호출 체인 — 전부 프레임워크/런타임 내부지식이다. 일반 파이썬 추론(K-Gen)으로는 in-memory sqlite 분기를 도출할 수 없다.
- **primary type = T-DesignRefactor.** dominant 신호가 S6(조율된 구조 변경)다. localize는 hints가 떠먹여줘서 진짜 난점이 아니고("어디"는 이미 줌), 난점은 "라이프사이클을 어떻게 재배치해 커넥션을 주입·정리하느냐"의 설계에 있다. 따라서 T-DiffuseLoc(찾기가 난점)도 T-DirectMap(기계적 픽스)도 아닌 T-DesignRefactor.

## 난이도 티어
**T5 (어려움).** 이 티어로 미는 구조적 피처:
- **멀티파일·멀티헌크 조율(L3):** gold는 basehttp + sqlite/features 2파일이고, test_patch까지 합치면 testcases.py 시그니처(`_create_server`/`setUpClass`/`_make_connections_override`)가 코어 생성자 인자와 lockstep으로 바뀐다. ICLR 2024 컷에서 멀티파일·조율은 solve-rate를 크게 떨군다.
- **S6 + K-Domain 동시:** 라이프사이클 재설계와 django/sqlite 도메인지식이 둘 다 병목 → 루브릭 T5 프로파일(L3 + S6, 깊은 도메인)에 정확히 부합.
- **overfit/함정 트랩:** hints가 "close_request 한 줄이면 된다"고 거의 정답처럼 제시하지만, 그 한 줄은 in-memory sqlite에서 깨진다(요청 스레드가 부모 커넥션을 못 봄). naive 패치는 신규 close 테스트는 통과시키되 sqlite 회귀를 낸다 → overfit-risk 실재.
- **race condition:** 결함 자체가 비결정적(절반 확률)이라 재현/검증이 까다롭다.

**공식 라벨 = "1-4 hours"(대략 T4 prior).** 그러나 공식 라벨은 *개발자 구현시간*이라 (a) 멀티파일 조율 배선, (b) "쉬워 보이는 한 줄"의 overfit 함정, (c) in-memory sqlite 분기라는 도메인 트랩을 시간으로 충분히 반영하지 못한다. 이 세 피처가 에이전트 난이도를 한 단계 올려 **T5로 재조정**한다.

## 골드패치 분석
- **건드린 파일·함수:**
  - `django/core/servers/basehttp.py` : `ThreadedWSGIServer` (원래 body가 `daemon_threads = True` 한 줄) — `__init__(connections_override=None)`, `process_request_thread(request, client_address)`, `_close_connections()`, `close_request(request)` 추가. 모듈 상단에 `from django.db import connections` import.
  - `django/db/backends/sqlite3/features.py` : `django_test_skips` — in-memory sqlite에서 `close()`가 no-op이므로 신규 `servers.tests.LiveServerTestCloseConnectionTest.test_closes_connections`를 skip-set에 등록.
- **근본 원인:** `socketserver.ThreadingMixIn.process_request_thread()`가 요청마다 새 스레드를 만들고 `finally: shutdown_request → close_request`로 정리하는데, django의 `ThreadedWSGIServer`는 `close_request`를 오버라이드하지 않아 **요청 워커 스레드의 DB 커넥션이 닫히지 않는다.** `LiveServerThread.run()`은 종료 시 `connections.close_all()`을 하지만 그건 *서버 본체 스레드*일 뿐 요청 워커 스레드가 아니라, 커넥션이 teardown 시점까지 살아남아 `destroy_test_db()`와 레이스한다.
- **수정 요지:** ① `close_request()`를 오버라이드해 요청 정리 시 `_close_connections()`(=`connections.close_all()`) 호출 → 요청 스레드가 자기 커넥션을 닫게 함. ② 단, in-memory sqlite는 thread별 DB가 분리돼 요청 스레드가 부모 커넥션을 못 본다 → 생성자 `connections_override`로 부모 커넥션을 받아두고, `process_request_thread()`에서 `connections[alias] = conn`으로 thread-local `connections`를 부모 커넥션으로 덮어쓴 뒤 `super().process_request_thread()` 호출(collect-then-inject). ③ `_close_connections`를 별도 seam으로 분리해 테스트가 mocking으로 close 시점을 가로챌 수 있게 함. ④ sqlite skip-list 등록으로 in-memory(no-op close) 환경에서 신규 테스트를 스킵.

## 검증 (test_patch)
- **FAIL_TO_PASS (17개):** 핵심은 신규 `servers.tests.LiveServerThreadedTests`/`LiveServerViews`/`LiveServerAddress` 군 + 데이터 read("Data written to the database by a view can be read.")·fixture 가시성 테스트들이다. 이들이 한꺼번에 F2P에 묶인 이유는 test_patch가 `testcases.py`의 `_create_server`/`setUpClass`를 `connections_override` 시그니처로 바꿔 LiveServer 인프라 전체가 새 배선 위에서 재통과해야 하기 때문(시그니처 회귀 방지). 그 안의 진짜 신규 동작 검증이 `LiveServerTestCloseConnectionTest.test_closes_connections`.
- **픽스 증명 방식:** `CloseConnectionTestServer`가 `_close_connections`를 오버라이드해 닫힌 직후 `threading.Event`를 set. 테스트는 `_make_connections_override`에서 `CONN_MAX_AGE=None`으로 **Django 자동 close를 끄고** 순수하게 *서버가* 닫는지만 본다. `conn.connect()`로 커넥션을 연 뒤(`assertIsNotNone(conn.connection)`), `/model_view/` 요청으로 서버가 DB 접근(`jane`,`robert` 반환)을 확인하고, `closed_event.wait(0.1)` 후 `assertIsNone(conn.connection)`으로 **요청 워커 스레드가 커넥션을 닫았음**을 증명. 즉 "서버가 닫는다"는 인과를 Django 경로와 분리해 단정.
- **overfit 관점:** F2P가 17개로 두텁고, in-memory(`assertIsNone`)·non-in-memory(skip) 양쪽을 커버하며 thread-sharing 주입까지 간접 검증(서버가 부모 커넥션을 못 보면 `/model_view/`가 데이터를 못 읽음)하므로, "close_request 한 줄"짜리 special-case 패치는 sqlite에서 깨져 통과 못 한다 → overfit 저지 능력은 중상. 다만 race 기반이라 타이밍 flake 여지는 있음.
- **regression 관점:** PASS_TO_PASS = 2개(`LiveServerTestCaseSetupTest.test_set_up_class`, "Contrast to ...")로 좁지만, 실질 regression 보호는 F2P에 들어간 LiveServer 전체 스위트가 담당한다 — `connections_override`/`inc_thread_sharing`/`dec_thread_sharing` 짝을 어긋나게 배선하면 setUp/tearDown 레이스나 커넥션 누수로 이들이 깨진다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 `ThreadedWSGIServer`·`process_request_thread`·`close_request`를 직접 지목하고 CPython `socketserver` 호출 체인을 인용 → `django/core/servers/basehttp.py:ThreadedWSGIServer`로 직행. #22414(`LiveServerThread.run`의 `connections.close_all()`)와 대조해 "서버 본체는 닫지만 *요청 워커 스레드*는 안 닫는다"는 격차를 특정. 동시에 `test/testcases.py`의 `LiveServerThread`가 서버를 생성하는 지점(`_create_server`)을 cross-file로 따라가야 배선 좌표가 완성됨.
2. **픽스(올바른 일반화인 이유):** `close_request`에서 `connections.close_all()`만 부르는 것은 *반쪽*이다 — in-memory sqlite는 thread별 DB라 요청 스레드가 부모 커넥션을 보지 못해 `/model_view/`가 데이터를 못 읽고 close 대상도 엉뚱해진다. 따라서 (a) `connections_override`로 부모 커넥션을 주입받아 (b) `process_request_thread`에서 thread-local `connections`를 덮어쓰고 (c) `close_request`에서 닫는 **3-스텝 라이프사이클**이 올바른 일반화다. 부모 쪽(`setUpClass`)에서 `vendor=='sqlite' and is_in_memory_db()`인 커넥션만 골라 `inc_thread_sharing()`하고 tearDown에서 `dec_thread_sharing()`로 정확히 되돌리는 대칭도 일반화의 일부(특정 테스트만 통과시키는 hack이 아님).
3. **regression 안전:** `connections_override` 시그니처를 `testcases.py:_create_server`/`_create_server_thread`/`setUpClass`/`_tearDownClassInternal`과 lockstep으로 바꿔야 F2P의 LiveServer 스위트 전체가 살아남는다. `inc_thread_sharing`/`dec_thread_sharing`를 정확히 1:1로 짝지어야 P2P `test_set_up_class`와 다른 LiveServer 테스트들이 커넥션 누수/공유플래그 오염 없이 통과. sqlite in-memory에서 `close()`가 no-op이므로 신규 close 테스트는 features.py skip-list에 등록해 false-fail을 막는다.
4. **함정 회피:** 오라클 없는 에이전트의 최대 함정은 hints가 떠먹여준 **"close_request 한 줄"에서 멈추는 것** — 이 경우 in-memory sqlite 회귀(서버가 부모 커넥션 미공유)와 신규 테스트 실패를 동시에 낸다. 피하는 법: (i) in-memory sqlite는 thread별 DB라는 도메인 사실에서 thread-sharing 주입 필요성을 도출, (ii) `_close_connections` seam을 분리해 테스트가 close 시점을 관측 가능하게 함(없으면 race 검증 불가), (iii) 코어 생성자 인자와 `testcases.py` 배선을 동시에 고쳐 시그니처 드리프트로 인접 LiveServer 테스트가 깨지지 않게 함, (iv) sqlite skip-list 누락 시 in-memory 환경에서 신규 테스트가 영구 fail이라는 점을 기억.
