---
instance_id: django__django-13410
repo: django/django
base_commit: 580a4341cb0b4cbfc215a70afc004875a7e815f4
version: "3.2"
difficulty: <15 min fix
created_at: 2020-09-11T09:58:41Z
fail_to_pass: 2
pass_to_pass: 40
gold_files: [django/core/files/locks.py]
---

# django__django-13410

## 문제 요약
posix(`fcntl` 사용) 환경의 `django/core/files/locks.py` 락 구현이 항상 `False`를 반환하는 버그다. cpython의 `fcntl.flock`은 성공 시 `None`을 반환하고 실패 시 `OSError`를 발생시키는데, 기존 코드는 반환값을 `== 0`으로 비교해서 성공해도 `None == 0`이 `False`가 되어 버린다. 비차단 락(`LOCK_NB`)을 쓰려는 사용자는 락 획득 성공/실패를 반환값으로 알아야 하는데 항상 실패로 보여 무용지물이었다.

## 유형 분류
- 버그 카테고리: API-contract (반환값 의미 오해 — None/예외 기반 API를 정수 반환으로 잘못 해석)
- 서브시스템: django core files (파일 락 유틸리티)
- 증상 타입: silent-wrong (예외 없이 항상 잘못된 `False` 반환)
- 로컬라이제이션 신호: problem_statement가 파일 경로(`django/core/files/locks.py`), 함수(`lock`/`unlock`), 심지어 제안 diff까지 직접 명시 — 거의 핀포인트 제공.

## 골드패치 분석
- 건드린 파일/함수: `django/core/files/locks.py` 의 posix 분기 `lock(f, flags)`, `unlock(f)`
- 근본 원인: `fcntl.flock`은 성공 시 `None` 반환·실패 시 예외 발생인데, 코드가 `ret = fcntl.flock(...)` 후 `return ret == 0`로 처리. `None == 0`은 항상 `False`라 성공도 실패로 보고됨.
- 수정 요지: `lock`은 `try: fcntl.flock(...); return True / except BlockingIOError: return False`로 변경 — 예외 없으면 성공(`True`), 비차단 락 경합 시 발생하는 `BlockingIOError`만 잡아 `False` 반환. `unlock`은 단순히 `fcntl.flock(..., LOCK_UN)` 후 `return True`. (참고: 사용자 제안은 `OSError`였으나 골드는 더 좁은 `BlockingIOError`로 채택 — 실제 락 경합 신호만 포착.)

## 검증 (test_patch)
- FAIL_TO_PASS: `test_exclusive_lock`, `test_shared_lock` (둘 다 `files.tests.FileTests`). `tests/files/tests.py`가 `from django.core.files import File, locks`로 락 모듈을 직접 임포트.
- 어떻게 증명하나:
  - `test_exclusive_lock`: 같은 파일을 두 핸들 `f1`,`f2`로 연다. `lock(f1, LOCK_EX)`는 `True`(획득 성공), 이어 `lock(f2, LOCK_EX|LOCK_NB)`와 `lock(f2, LOCK_SH|LOCK_NB)`는 이미 배타락이 잡혀 있으니 `False`여야 함. `unlock(f1)`은 `True`. `assertIs(..., True/False)`로 정확히 불리언 동일성을 확인해 기존의 항상-`False` 버그를 잡아낸다.
  - `test_shared_lock`: `f1`에 `LOCK_SH`(공유락) → `True`, `f2`에 `LOCK_SH|LOCK_NB`도 공유락이라 동시 획득 가능 → `True`, 양쪽 `unlock` → `True`. 버그 상태면 첫 락부터 `False`라 즉시 실패.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 파일·함수·원인·제안 diff가 모두 들어 있어 탐색 비용 거의 0. `locks.py`의 `else`(posix) 분기 `lock`/`unlock`만 보면 됨.
- 함정/난이도 메모: (1) 윈도우(`msvcrt`) 분기는 건드리면 안 됨 — 같은 파일 안에 두 구현이 공존. (2) `except` 절을 광범위한 `OSError`로 잡아도 테스트는 통과하지만 골드는 `BlockingIOError`로 더 좁힘 — 다른 종류의 OSError까지 삼키면 진짜 에러를 숨길 수 있어 의미상 차이가 있다. (3) `unlock`에는 예외 처리를 두지 않고 무조건 `True` 반환하는 것이 골드 선택.
- 우리 에이전트 관점: 난이도가 매우 낮아 거의 받아쓰기 수준. 위험은 단 하나 — `OSError` vs `BlockingIOError` 선택. 테스트는 둘 다 green이라 LLM-judge나 grading만으로는 차이를 못 잡으므로, 더 좁은 예외를 고르는 판단력이 품질 변별점이다.
