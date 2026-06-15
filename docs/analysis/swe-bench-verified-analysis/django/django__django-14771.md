---
instance_id: django__django-14771
repo: django/django
base_commit: 4884a87e022056eda10534c13d74e49b8cdda632
version: "4.1"
difficulty: 15 min - 1 hour
created_at: 2021-08-15T07:26:17Z
fail_to_pass: 1
pass_to_pass: 60
gold_files: [django/utils/autoreload.py]
---

# django__django-14771

## 문제 요약
`runserver`의 auto-reloader가 자식 프로세스를 재기동할 때 부모 프로세스에 넘긴 `-X` 옵션(예: `-X utf8`)을 전달하지 않는다. 그래서 `python -X utf8 manage.py runserver`로 띄우면 메인 프로세스는 UTF-8로 동작하지만, reloader가 띄운 워커 프로세스는 옵션이 사라져 다른 인코딩(예: cp936)으로 떨어진다. 사용자는 `--noreload`일 때와 동일하게 `-X` 옵션이 워커에도 유지되길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (재기동 인자 구성 시 `-X` 옵션 누락)
- 서브시스템: django.utils.autoreload (runserver auto-reload 프로세스 재기동)
- 증상 타입: silent-wrong (예외 없이 자식 프로세스가 잘못된 런타임 옵션으로 실행됨)
- 로컬라이제이션 신호: "Auto-reloader should pass -X options", `sys._xoptions` 링크, `--noreload`와의 차이 → 자식 인자를 만드는 `get_child_arguments()`가 유일한 후보

## 골드패치 분석
- 건드린 파일/함수: `django/utils/autoreload.py:get_child_arguments()`
- 근본 원인: `args`를 구성할 때 `sys.executable`과 `sys.warnoptions`(`-W`) 만 복원하고, 부모가 받은 `sys._xoptions`(`-X`)는 전혀 반영하지 않았다. reloader는 새 인터프리터를 spawn하므로 명시적으로 옵션을 다시 넘기지 않으면 유실된다.
- 수정 요지: `-W` 옵션 추가 직후, `sys.implementation.name == 'cpython'`일 때만 `sys._xoptions.items()`를 순회하며 `args`에 `-X` 인자를 확장한다. 값이 `True`인 경우(플래그형, 예 `utf8`)는 `-X{key}`, 값이 있는 경우는 `-X{key}={value}` 형태로 만든다. CPython 한정으로 둔 것은 `_xoptions`가 구현 의존적이기 때문.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_xoptions (utils_tests.test_autoreload.TestChildArguments)` — `sys._xoptions`가 비어있지 않을 때 `-X` 인자가 자식 인자에 포함되는지 검증.
- 증명 방식: `sys._xoptions`를 `{'utf8': True, 'a': 'b'}`로 mock하고 `get_child_arguments()` 호출 → 기대 출력 `[sys.executable, '-Xutf8', '-Xa=b', __file__, 'runserver']`. `True`→플래그형, `'b'`→`key=value`형 두 분기를 한 번에 커버한다. 나머지 기존 `TestChildArguments` 테스트들에는 `@mock.patch('sys._xoptions', {})`를 추가해 빈 경우 출력이 변하지 않음(회귀 방지)을 보장한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `autoreload.py`에서 `sys.executable`/`sys.warnoptions`/`sys.argv`로 재기동 인자를 조립하는 단일 함수 `get_child_arguments()`만 보면 된다. `-W` 처리 라인이 정확한 삽입 지점.
- 함정/난이도 메모: (1) `_xoptions` 값의 두 형태(플래그형 `True` vs `key=value`)를 모두 처리해야 함 — 한쪽만 하면 `test_xoptions` 절반만 통과. (2) `sys.implementation.name == 'cpython'` 가드를 빼면 동작은 하지만 골드 의도(구현 의존성)와 어긋남. (3) 단일 파일, 단일 함수 수정이라 멀티파일은 아님.
- 우리 에이전트 관점: 난이도 낮은 누락 추가형. 막힐 지점은 `_xoptions` 딕셔너리의 값 형태를 정확히 알아 두 분기를 만드는 것과, 기존 테스트들이 `sys._xoptions`를 mock하지 않으면 환경의 실제 `-X` 옵션 때문에 flaky해질 수 있다는 점(테스트 측 mock 동반 필요)을 인지하는 것.
