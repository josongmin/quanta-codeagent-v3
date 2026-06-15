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
---

# django__django-14011

## 문제 요약
`LiveServerTestCase`가 사용하는 `ThreadedWSGIServer`가 요청마다 새 스레드를 띄우지만, 그 스레드들이 끝날 때 DB 커넥션을 닫지 않는다. 그 결과 테스트 종료 시 `destroy_test_db()`가 호출되면 `OperationalError: database "test_myapp" is being accessed by other users`가 절반 정도 확률로 발생한다(레이스 컨디션). 사용자는 1.11에서 #22414로 고쳐졌던 동작(요청 스레드가 자기 커넥션을 닫음)이 2.2의 스레딩 도입(#20238)으로 회귀했다고 보고했다.

## 유형 분류
- 버그 카테고리: regression / 누락처리 (스레드 종료 시 커넥션 close 누락)
- 서브시스템: django test framework / dev WSGI server (`core.servers.basehttp`, `test.testcases` LiveServer)
- 증상 타입: 간헐적 크래시 (race condition, teardown 시 OperationalError)
- 로컬라이제이션 신호: problem_statement가 `ThreadedWSGIServer`, `LiveServerThread`, `process_request_thread`, `close_request`를 직접 지목하고 CPython `socketserver.ThreadingMixIn` 코드까지 인용 — 사실상 핀포인트.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/core/servers/basehttp.py`:`ThreadedWSGIServer` — `__init__`, `process_request_thread`, `_close_connections`, `close_request` 추가
  - `django/db/backends/sqlite3/features.py`:`django_test_skips` — 신규 테스트 skip 등록
- 근본 원인: `ThreadingMixIn.process_request_thread()`가 요청마다 새 스레드를 만드는데, 그 스레드는 자기 DB 커넥션을 닫지 않는다. `LiveServerThread.run()`은 종료 시 `connections.close_all()`을 하지만 그건 서버 스레드 본체일 뿐 요청 워커 스레드가 아니라서, in-memory sqlite 등에서 커넥션이 살아남아 teardown과 레이스.
- 수정 요지: `ThreadedWSGIServer.close_request()`를 오버라이드해 요청 정리 시 `_close_connections()`(=`connections.close_all()`)를 호출하도록 함. 또한 부모 스레드의 커넥션을 자식 요청 스레드에 주입하기 위해 `connections_override` 생성자 인자를 받고, `process_request_thread()`에서 각 alias의 커넥션을 `connections[alias] = conn`으로 덮어써 sqlite in-memory 공유를 보장. `_close_connections`는 테스트 mocking 용 seam으로 분리.

## 검증 (test_patch)
- FAIL_TO_PASS: 기존 LiveServer 테스트 17개(주소/뷰/keep-alive/static 등)가 `connections_override` 시그니처 변경에 맞춰 다시 통과해야 하고, 신규 `LiveServerTestCloseConnectionTest.test_closes_connections`가 핵심.
- 테스트 증명 방식: `CloseConnectionTestServer`가 `_close_connections`를 오버라이드해 닫힌 직후 `threading.Event`를 set. 테스트는 `CONN_MAX_AGE=None`으로 Django 자동 close를 막아 순수하게 서버가 닫는지를 검증. `conn.connect()`로 커넥션을 연 뒤 `/model_view/`에 요청(서버가 DB 접근해 `jane`,`robert` 반환 확인), 그다음 `closed_event.wait(0.1)` 후 `assertIsNone(conn.connection)`으로 요청 스레드가 커넥션을 닫았음을 확인. test_patch는 `testcases.py`에 `connections_override` 배선과 `_make_connections_override` 분리도 포함.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement/hints가 이미 `ThreadedWSGIServer` + `close_request` 오버라이드를 거의 정답 코드로 제시. `django/core/servers/basehttp.py`의 `ThreadedWSGIServer`(원래 body가 `daemon_threads = True` 한 줄뿐)에서 시작.
- 함정/난이도: (1) 단순히 `close_request`만 추가하면 in-memory sqlite는 요청 스레드에서 커넥션 공유가 안 돼 깨진다 — `connections_override` 주입 + `process_request_thread`에서 thread-local `connections` 교체가 필수. (2) 멀티파일: 코어 fix 외에 sqlite `django_test_skips`에 새 테스트를 등록해야 in-memory에서 close가 no-op이라 스킵됨(누락 시 sqlite에서 fail). (3) `_close_connections` seam을 따로 빼야 테스트가 mocking으로 이벤트를 잡을 수 있음.
- 우리 에이전트 관점: hints가 너무 친절해서 `close_request` 한 줄짜리 패치로 끝낼 위험이 크다. 실제 골드는 thread-sharing 주입과 sqlite skip-list까지 묶인 다중 파일 수정이라, "간단해 보이는 한 줄"의 함정에 빠지면 sqlite in-memory 회귀와 신규 테스트 실패를 동시에 놓친다. test_patch가 `testcases.py` 시그니처(`connections_override`)까지 바꾸므로 코어 생성자 인자와 정확히 맞춰야 한다.
