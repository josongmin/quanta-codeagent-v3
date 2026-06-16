---
instance_id: sphinx-doc__sphinx-7889
repo: sphinx-doc/sphinx
base_commit: ec9af606c6cfa515f946d74da9b51574f2f9b16f
version: "3.2"
difficulty: "<15 min fix"
created_at: 2020-06-29T16:20:55Z
fail_to_pass: 1
pass_to_pass: 5
gold_files: [sphinx/ext/autodoc/mock.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro]
---

## 문제 요약
generic 타입(예: `class Foo(Base[T])`, `T = TypeVar('T')`)을 가진 클래스의 문서를 빌드할 때 autodoc의 mock 경로에서 `TypeError`가 발생한다. mock된 베이스를 `Base[T]`로 서브스크립트하면 `_MockObject.__getitem__`이 `key=TypeVar`를 받고, 이를 그대로 `_make_subclass`에 넘겨 `module + '.' + name` 즉 `str + TypeVar` 연결을 시도하다 터진다. 기대 동작은 generic이 섞여도 docs 빌드가 성공하는 것.

## 유형 (정형화)
- **L = L1 (Traceable)**: 이슈 본문이 `mock._make_subclass`가 `str`에 `TypeVar`를 concat한다고 거의 함수까지 지목한다. 스택트레이스(첨부 로그)와 "concatenate a `str` to a `TypeVar`" 문장으로 단일 파일 `sphinx/ext/autodoc/mock.py`로 즉시 수렴. L0에 근접하나 실제 결함 위치는 `_make_subclass`가 아니라 그 호출부 `__getitem__`이라 한 단계 추적이 필요해 L1.
- **S = S1 (Direct-Map) +S2**: 결함클래스가 "타입강제(type coercion)" 템플릿에 정확히 매칭 — `key`를 `str(key)`로 강제하면 끝. 다만 "어느 인자를 강제해야 하나(`__getitem__`의 `key`이지 `_make_subclass` 내부가 아님)"와 타입힌트 `str→Any`까지 같이 손봐야 일관되므로 가벼운 S2 보조.
- **K = K-Gen**: sphinx autodoc 내부 도메인 지식 불필요. `str + TypeVar`가 왜 터지는지, generic 서브스크립트가 `__getitem__`을 호출한다는 일반 파이썬 지식이면 충분.
- **primary_type = T-DirectMap**: 위치가 거의 명시되고 픽스가 기계적 타입강제(가드/coercion 템플릿)라 T-DirectMap. T-LocTrivial이 아닌 이유는 픽스 지점이 이슈가 지목한 `_make_subclass`가 아니라 그 호출부라 한 번 짚어줘야 하기 때문.
- **repair strategy 근거 (APR)**: PAR/TBar식 결함패턴 "string-concat-on-nonstr → coerce to str"의 직접 적용. 후보 탐색(G&V)이나 스펙 재구성(S5) 불필요 — 올바른 동작이 자명(문자열 이름 생성)하므로 Direct-Map.

## 난이도 티어
- **티어: T2 (쉬움)**. 구조적 피처: 단일 파일(`mock.py`) / 실질 2줄 변경(`__getitem__` 시그니처+본문) / localize 직접성 높음(이슈가 함수명·에러원인 명시) / `has-repro`(첨부 로그+재현 레포 screenpy). 도메인 지식 거의 0. P2P 5개로 좁아 regression-trap 약함.
- **공식 라벨 `<15 min fix`와 일치**. 시간라벨이 곧 T1~T2 구간. T1(존나쉬움)이 아닌 이유: 픽스 지점이 이슈가 가리킨 `_make_subclass`가 아니라 호출부 `__getitem__`이라 "이슈가 픽스를 그대로 적어줌" 수준은 아니고, 어디에 `str()`을 넣을지 한 번 판단해야 한다. 그래서 T1이 아니라 T2.

## 골드패치 분석
- **건드린 파일·함수**: `sphinx/ext/autodoc/mock.py`의 `_MockObject.__getitem__`.
- **근본원인**: generic 서브스크립트 `MockBase[T]`는 파이썬에서 `MockBase.__getitem__(T)`를 호출한다. mock된 베이스의 `__getitem__(self, key: str)`은 `key`가 항상 `str`이라 가정했지만, 실제로는 `TypeVar`(또는 임의 객체)가 들어온다. 이 `key`를 `_make_subclass(key, ...)`의 `name`으로 넘기면 `_make_subclass` 내부 `'__display_name__': module + '.' + name`에서 `str + TypeVar` 연결이 일어나 `TypeError`. 즉 결함은 입력 타입 가정 위반이고, 호출 경계에서 강제하지 않은 것.
- **수정요지**: 시그니처를 `key: str` → `key: Any`로 넓히고(거짓 타입계약 제거), 본문을 `_make_subclass(str(key), ...)`로 바꿔 `key`를 문자열로 강제. 이제 `TypeVar`든 무엇이든 `str()`이 안전한 표시이름을 만들어 concat이 성공한다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `tests/test_ext_autodoc_mock.py::test_MockObject`에 "parametrized type" 블록 추가 — `T = TypeVar('T')` 후 `class SubClass2(mock.SomeClass[T])`를 정의하고 `SubClass2.__doc__`, `isinstance(obj2, SubClass2)`를 단언. `mock.SomeClass[T]`가 바로 `__getitem__(TypeVar)`을 트리거하므로 픽스 전이면 클래스 정의 시점에 `TypeError`로 죽고, `str(key)` 픽스 후에야 서브클래싱이 완료되어 테스트가 통과한다. 픽스가 정확히 이 경로를 증명.
- **overfit 관점**: `str(key)`는 특정 입력(TypeVar)에만 맞춘 special-case가 아니라 모든 비문자열 key를 일반적으로 처리하는 coercion이라 overfit 아님. FAIL_TO_PASS가 1개로 얇지만, 픽스가 입력공간 전체를 덮어 underspecify 위험 낮음.
- **regression 관점**: 기존 `__getitem__`은 `str` key만 받았는데 `str("abc") == "abc"`라 문자열 입력 동작 불변. P2P 5개(`test_mock`, `test_MockModule`, `test_abc_MockObject`, `test_mock_decorator`, `test_mock_does_not_follow_upper_modules`)는 서브스크립트 경로를 타지 않으므로 영향 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "Autodoc's `mock._make_subclass` attempts to concatenate a `str` to a `TypeVar`" + 첨부 스택트레이스 → `sphinx/ext/autodoc/mock.py` 열어 `_make_subclass`의 `module + '.' + name` 라인 확인 → `name` 출처를 역추적해 generic 서브스크립트가 타는 호출부 `_MockObject.__getitem__(self, key)`가 진짜 진입점임을 식별.
2. **픽스와 일반화**: 두 가지 선택지 — (a) `_make_subclass` 내부에서 `str(name)`, (b) 호출 경계 `__getitem__`에서 `str(key)`. 골드는 (b)를 택했다. 이유: 결함의 원천은 `__getitem__`이 받은 잘못된 타입 가정이고, 경계에서 강제하면 시그니처를 `Any`로 정직하게 표기하면서 `__getattr__`(여기 key는 항상 식별자 str) 등 다른 호출부의 의미를 흐리지 않는다. `str(key)`는 TypeVar뿐 아니라 임의 객체를 일반적으로 흡수하므로 올바른 일반화.
3. **regression 안전**: 문자열 key는 `str()` 항등으로 동작 보존 → 기존 서브스크립트/attr 접근 동작 불변. P2P 5개는 서브스크립트 미사용이라 안전. `__getitem__`만 손대고 `__getattr__`은 건드리지 않아 부작용 면적 최소.
4. **함정 회피**: 오라클 없는 에이전트의 오답 위험 — (i) 이슈 문구만 보고 `_make_subclass` 내부 `name`을 고치면 동작은 통과하나 결함 origin을 잘못 짚어 시그니처 거짓계약(`key: str`)이 남는다; 골드처럼 경계 강제가 더 정확. (ii) `__getitem__`의 `key: str` 타입힌트를 그대로 둔 채 `str(key)`만 넣으면 타입계약 거짓말이 남으므로 `Any`로 넓혀야 일관. (iii) `try/except TypeError` 같은 방어적 땜빵은 표시이름을 잃거나 다른 오류를 삼킬 수 있어 부적절 — 단순 coercion이 정답.
