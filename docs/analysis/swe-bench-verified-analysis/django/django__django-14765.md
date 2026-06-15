---
instance_id: django__django-14765
repo: django/django
base_commit: 4e8121e8e42a24acc3565851c9ef50ca8322b15c
version: "4.0"
difficulty: <15 min fix
created_at: 2021-08-12T05:59:11Z
fail_to_pass: 1
pass_to_pass: 64
gold_files: [django/db/migrations/state.py]
---

# django__django-14765

## 문제 요약
선행 PR #14760으로 `ProjectState.__init__()`를 호출하는 모든 코드가 `real_apps`를 이미 set으로 전달하도록 정리됐다. 따라서 생성자 안에서 set 여부를 검사하고 아니면 변환하던 방어 로직은 더 이상 필요 없다. 대신 non-None일 때 set임을 단언(assert)하도록 바꿔, ProjectState 생성이 Django 내부 API라는 계약을 명시하자는 리팩터링 요청이다.

## 유형 분류
- 버그 카테고리: API-contract (방어적 변환 제거 + 불변식 단언으로 내부 계약 강제)
- 서브시스템: django migrations / ProjectState (migration state 구성)
- 증상 타입: 기능 버그 아님 — 내부 계약 정리(리팩터링); set 아닌 입력이 silent하게 허용되던 것을 차단
- 로컬라이제이션 신호: problem_statement가 `ProjectState.__init__()`와 PR #14760(real_apps를 set으로 통일)을 직접 지목 → 단일 함수로 바로 연결

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/state.py` → `ProjectState.__init__()`
- 근본 원인: 기존 코드는 `real_apps`가 set이 아니면 `set(real_apps)`로 변환해 받아줬다. 모든 호출부가 set을 넘기게 정리된 뒤에도 이 변환이 남아 비-set 입력을 silent하게 허용하는 느슨한 계약이 유지됐다.
- 수정 요지: `if real_apps:` 분기를 `if real_apps is None: real_apps = set()` / `else: assert isinstance(real_apps, set)`로 교체. None이면 빈 set, non-None이면 set임을 단언하고 그대로 `self.real_apps`에 할당. 변환 로직 제거로 비-set 입력은 `AssertionError`로 즉시 실패. (빈 컬렉션도 None 대신 falsy로 빠지던 `if real_apps:`의 미묘한 차이도 `is None`으로 명확화)

## 검증 (test_patch)
- FAIL_TO_PASS: `test_real_apps_non_set (migrations.test_state.StateTests)`
- 테스트가 어떻게 픽스를 증명하는지: `ProjectState(real_apps=['contenttypes'])`처럼 list(비-set)를 넘기면 `AssertionError`가 발생함을 `assertRaises`로 확인. 픽스 전에는 list가 set으로 변환돼 예외 없이 통과했으므로 테스트가 실패(FAIL), 픽스 후 단언이 걸려 통과(PASS). PASS_TO_PASS 63개는 set/None 정상 경로가 깨지지 않았음을 보증.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 함수명(`ProjectState.__init__`)과 파일 위치가 사실상 명시. `django/db/migrations/state.py`에서 `real_apps` 처리 분기만 보면 됨. 단일 파일·단일 함수.
- 함정/난이도 메모: 핵심은 "변환을 제거하고 assert로 바꾼다"는 의도를 정확히 읽는 것. `set(real_apps)` 변환을 남겨두면 테스트가 실패한다. None 처리를 빠뜨리거나 falsy(`if real_apps:`) 그대로 두면 빈 set/빈 컬렉션 경계에서 어긋날 수 있음. 멀티파일 아님 — 호출부 수정 불필요(이미 PR #14760에서 끝남).
- 우리 에이전트 관점: 막힐 지점은 "버그가 아니라 의도적으로 더 엄격하게 만드는 리팩터링"이라는 점. 방어적으로 변환을 유지하려는 경향(에이전트가 입력을 너그럽게 받으려는 습관)이 정답과 정반대다. test_patch가 AssertionError를 기대한다는 신호를 먼저 잡아야 변환 제거 방향으로 정렬됨.
