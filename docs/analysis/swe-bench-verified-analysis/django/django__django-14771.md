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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-14771

## 문제 요약
`runserver`의 auto-reloader가 자식 워커 프로세스를 재기동할 때, 부모 프로세스에 넘긴 `-X` 옵션(예: `-X utf8`)을 전달하지 않는다. 그래서 `python -X utf8 manage.py runserver`로 띄우면 메인 프로세스는 UTF-8로 동작하지만, reloader가 spawn한 워커 프로세스는 `-X` 옵션이 유실되어 다른 인코딩(이슈 재현에선 cp936)으로 떨어진다. 사용자는 `--noreload`(reloader 미사용, 재기동 없음)일 때와 **동일하게** `-X` 옵션이 워커에도 유지되길 기대한다. 이슈 본문은 Windows에서의 재현 절차와 함께 `sys._xoptions` / `open()` 문서 링크를 직접 제시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈 제목이 "Auto-reloader should pass -X options"로 동작·서브시스템을 직접 지목하고, `sys._xoptions` 링크와 `--noreload` 대비를 준다. 재기동 인자를 조립하는 함수는 `autoreload.py`의 `get_child_arguments()` 단 하나 — grep 한 방. cross-module 추적 불필요.
- **S (Repair Strategy) = S1 Direct-Map (+S2).** 정형 결함클래스 "재기동 시 런타임 옵션 누락(propagation gap)"에 템플릿 매칭된다. 바로 위에 이미 `-W`(`sys.warnoptions`)를 복원하는 코드가 있어, `-X`(`sys._xoptions`)도 같은 패턴으로 한 블록 추가하면 끝나는 기계적 픽스다. 다만 순수 S1은 아니다: `_xoptions` 값이 플래그형(`True` → `-Xkey`)과 `key=value`형(`-Xkey=value`) 두 형태를 가진다는 점, 그리고 `sys.implementation.name == 'cpython'` 가드가 필요하다는 점은 약한 constraint 추론(S2)을 동반하므로 보조 표기.
- **K (Knowledge) = K-Domain.** 일반 파이썬 추론만으로는 `sys._xoptions`의 dict 값 형태(bool vs str)와 `_xoptions`가 CPython 구현 의존적이라 다른 구현(PyPy 등)에서 보장 안 된다는 점을 알기 어렵다. 인터프리터 런타임 옵션 전파 + reloader가 새 인터프리터를 spawn한다는 django 내부 동작 지식이 병목.
- **Primary = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기존 `-W` 미러링이라 기계적(S1 dominant)이므로 "위치 명확 + S1 기계적 픽스" 정의에 정확히 부합. T-DomainBound이 아닌 이유: 도메인지식은 값 형태 디테일을 맞추는 보조 역할이고, 진짜 본질은 자명한 위치에 옵션 전파를 끼워 넣는 direct-map이다.

## 난이도 티어
**T2 (쉬움).** 이 티어로 미는 구조적 피처:
- **1파일·1함수·5줄 추가** (`get_child_arguments()`에 `if` 블록 하나). ICLR-2024 컷의 "1파일·<5줄 ≈ 48% solve" 구간에 든다.
- **L0 직접 localize** + has-repro급 재현 절차(이슈에 명령어·기대출력 포함)로 탐색 비용 거의 0.
- 픽스가 **인접 `-W` 라인의 미러**라 합성 부담이 낮음.
- T1이 아닌 이유: 픽스가 이슈에 그대로 적혀 있지 않고, `_xoptions` 값의 두 형태 분기 + cpython 가드라는 가벼운 엣지 추론(S2)과 K-Domain이 끼어 "거의 적어줌"은 아니다.
- T3+가 아닌 이유: 실질적 다단계 추론이나 약한 localize 노력이 없다.

공식 라벨은 "15 min - 1 hour"로 T2~T3 경계의 prior를 준다. 본 분석은 L0 + S1 미러 픽스라는 구조 때문에 **T2로 약간 낮춰** 둔다 — 공식 라벨은 개발자가 `_xoptions` 형태를 확인하고 테스트 mock 6곳을 손보는 구현시간을 반영하지만, 에이전트의 localize·합성 난이도 자체는 더 낮다.

## 골드패치 분석
- **건드린 파일·함수:** `django/utils/autoreload.py` → `get_child_arguments()`.
- **근본 원인:** `args`를 조립할 때 `sys.executable` + `sys.warnoptions`(`-W`)만 복원하고, 부모가 받은 `sys._xoptions`(`-X`)는 전혀 반영하지 않았다. reloader는 워커를 새 인터프리터로 spawn하므로, 명시적으로 다시 넘기지 않으면 `-X` 런타임 옵션(인코딩 등)이 silent하게 유실된다(예외 없이 잘못된 동작).
- **수정 요지:** `-W` 옵션을 확장하는 라인 바로 다음에 블록을 추가:
  ```python
  if sys.implementation.name == 'cpython':
      args.extend(
          f'-X{key}' if value is True else f'-X{key}={value}'
          for key, value in sys._xoptions.items()
      )
  ```
  값이 `True`인 플래그형 옵션(예 `-X utf8`)은 `-X{key}`로, 값이 있는 옵션은 `-X{key}={value}`로 직렬화한다. `sys.implementation.name == 'cpython'` 가드는 `_xoptions`가 CPython 구현에 한정된 인터페이스이기 때문에 둔 것.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_xoptions (utils_tests.test_autoreload.TestChildArguments)`. `sys._xoptions`를 `{'utf8': True, 'a': 'b'}`로 mock하고 `sys.argv`/`sys.warnoptions`를 고정한 뒤 `get_child_arguments()`를 호출 → 기대 출력 `[sys.executable, '-Xutf8', '-Xa=b', __file__, 'runserver']`.
- **픽스 증명:** 단일 테스트가 두 분기를 동시에 커버한다 — `utf8: True` → 플래그형 `-Xutf8`, `a: 'b'` → `key=value`형 `-Xa=b`. 한쪽 분기만 구현하면(예: 항상 `-Xkey=value`) `utf8` 케이스가 `-Xutf8=True`로 나와 즉시 RED. 순서(자식 `args` 끝부분, `__file__` 앞)까지 고정해 삽입 위치도 강제한다.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇지만, 테스트가 두 값 형태를 함께 박아 special-case 통과를 막아 overfit 위험은 낮다. 미검증 입력공간은 cpython 가드 분기(비-cpython 경로) 정도이나 골드도 명세적으로만 처리하므로 oracle-level 미세화 여지로 본다 → 플래그엔 미표기.
- **regression 관점:** PASS_TO_PASS 60개 중 핵심은 같은 `TestChildArguments` 클래스의 기존 케이스들(`test_run_as_module`, `test_run_as_non_django_module`, `test_warnoptions`, `test_entrypoint_fallback`, `test_module_no_spec` 등). test_patch는 이들 전부에 `@mock.patch('sys._xoptions', {})`를 추가해 **빈 `_xoptions`에서 출력이 byte-identical하게 유지**됨을 못박는다. 이 mock이 없으면 실행 환경의 실제 `-X` 옵션이 새 코드 경로로 새어 들어와 기대 인자 리스트가 달라지는 flaky 회귀가 생긴다 → regression-trap 플래그의 근거.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈 제목("Auto-reloader should pass -X options") + `--noreload`와의 차이 + `sys._xoptions` 링크 → reloader가 워커를 재기동할 때 인자를 만드는 코드를 찾는다. `django/utils/autoreload.py`에서 `sys.executable`/`sys.argv`/`sys.warnoptions`로 자식 인자를 조립하는 함수 `get_child_arguments()`가 유일 후보. 이미 `-W` 옵션을 `['-W%s' % o for o in sys.warnoptions]`로 복원하는 라인이 정확한 삽입 앵커.
2. **픽스(왜 올바른 일반화):** `-W`(warnoptions) 복원 패턴을 그대로 미러링해 `sys._xoptions`도 전파한다. `_xoptions`가 dict이고 값이 플래그형(`True`)·값형(`str`) 두 가지이므로 `-X{key}` / `-X{key}={value}` 두 분기를 모두 만든다. 이는 특정 옵션(`utf8`) 하드코딩이 아니라 `_xoptions.items()` 전체를 일반 전파하므로 overfit이 아닌 올바른 일반화 — `--noreload` 경로(재기동 없음)와 동등한 런타임을 워커에 재구성한다는 불변식을 충족.
3. **regression 안전:** 기존 `TestChildArguments` 케이스들이 빈 `_xoptions` 상태에서 동일 출력을 내야 한다. 신규 블록은 `sys._xoptions`가 비면 0개 인자를 extend하므로 기능적으로 무해하지만, **테스트가 실행 환경의 실제 `-X`에 오염되지 않도록** 기존 케이스에도 `@mock.patch('sys._xoptions', {})`를 동반해야 60개 PASS_TO_PASS를 안전하게 지킨다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) `_xoptions` 값 형태를 한쪽만 처리(항상 `-Xkey=value`)하면 `-Xutf8=True`가 나와 절반만 통과. 두 분기를 반드시 본다. (b) `sys.implementation.name == 'cpython'` 가드를 누락하면 테스트는 통과하나 골드 의도(구현 의존성)와 어긋남 — `_xoptions`가 CPython 한정 인터페이스임을 알아야 한다. (c) 코드만 고치고 기존 테스트에 `_xoptions` mock을 안 넣으면, 채점 환경에서 실제 `-X` 옵션이 끼어 인접 PASS_TO_PASS가 flaky하게 깨진다 — 코드와 테스트 mock을 **함께** 제출해야 한다.
