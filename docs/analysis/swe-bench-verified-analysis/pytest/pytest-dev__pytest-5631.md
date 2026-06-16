---
instance_id: pytest-dev__pytest-5631
repo: pytest-dev/pytest
base_commit: cb828ebe70b4fa35cd5f9a7ee024272237eab351
version: "5.0"
difficulty: "15 min - 1 hour"
created_at: 2019-07-19T20:13:12Z
fail_to_pass: 1
pass_to_pass: 15
gold_files: [src/_pytest/compat.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [has-repro]
---

## 문제 요약
`@patch(target=..., new=np.array([...]))` 처럼 `new`가 numpy 배열인 테스트를 수집(collect)하면 `ValueError: The truth value of an array with more than one element is ambiguous`가 발생한다. 이슈는 네이티브 스택트레이스와 원인 커밋(b6166dcc)까지 직접 제시한다. 원인은 `num_mock_patch_args`의 `p.new in sentinels` 비교가 `__eq__`를 호출해 numpy처럼 진리값이 모호한 객체에서 깨지는 것이다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 스택트레이스로 `src/_pytest/compat.py:94`의 `p.new in sentinels` 라인과 함수 `num_mock_patch_args`를 직접 지목한다. grep 한 방. localize 노력 0.
- **S2 (Constraint-Reasoning)**: 위치는 자명하나, 픽스가 단순 None가드/상수변경이 아니다. "왜 `in`이 깨지나(`__eq__` 기반 멤버십 → 배열 진리값 모호)"를 이해하고, "센티넬 비교는 **동등성이 아니라 동일성(identity)이어야 한다**"는 불변식을 추론해 `is` 비교로 합성해야 한다. SemFix/Angelix 계열의 의미적 합성.
- **K-Gen**: numpy/mock 도메인 내부지식 불필요. "배열은 `==`가 element-wise라 truth가 모호하다"는 일반 파이썬 상식과 센티넬은 identity로 비교한다는 일반 원칙이면 충분.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 올바른 조건식(`is` + 안전한 fallback 센티넬)을 추론으로 합성하는 것이 본질. S1 템플릿 매칭으론 안 풀린다.

왜 S2인가(APR 관점): 결함 위치는 주어졌지만 올바른 수리는 "동등성 비교를 동일성 비교로 바꾸고, 모듈 미import 시 절대 매칭되지 않는 sentinel을 보장"하는 의미적 제약을 만족해야 한다. 후보를 마구 생성·검증(S3)하기보다 불변식을 따져 한 번에 맞히는 문제다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일수 1 / 함수 1(`num_mock_patch_args`) / 실질 변경 ~12줄 — scope는 T1~T2급으로 작다.
- localize 직접성 = 최상(L0, 스택트레이스 + 원인 커밋 명시). `has-repro`로 easiness 신호 강함.
- 그러나 픽스가 단순 가드가 아니라 **identity-vs-equality 의미 추론**을 요구하고, 모듈 미존재 시 `getattr(..., object())` sentinel로 false-positive를 막는 **두 번째 미묘함**까지 동시에 맞춰야 한다. 이 추론 부담이 T2가 아닌 T3로 민다.
- P2P 15개가 모두 같은 `integration.py`의 mock/fixture 동작이라 regression-trap은 중간(좁은 영역, 깨지면 즉시 드러남).

공식 라벨 "15 min - 1 hour"와 정합. 시간 자체는 짧지만 "왜 `in`이 틀렸는가"를 깨닫는 추론 단계가 있어 trivial(T1)은 아니다.

## 골드패치 분석
- **파일·함수**: `src/_pytest/compat.py`의 `num_mock_patch_args(function)`.
- **근본원인**: 기존 코드는 `sentinels = [m.DEFAULT for m in mock_modules if m is not None]` 리스트를 만들고 `p.new in sentinels`로 멤버십 검사를 했다. `in`은 내부적으로 `p.new == sentinel`을 호출하는데, `p.new`가 numpy 배열이면 `__eq__`가 boolean 배열을 반환하고 멤버십 로직이 이를 `bool()`로 평가하려다 `ValueError`로 터진다(commit b6166dcc가 도입한 회귀).
- **수정요지**: 두 가지를 동시에 처리.
  1. `mock_sentinel = getattr(sys.modules.get("mock"), "DEFAULT", object())` 및 `ut_mock_sentinel = getattr(sys.modules.get("unittest.mock"), "DEFAULT", object())` — 모듈이 import 안 됐으면 새 `object()`를 두어 **어떤 `p.new`와도 절대 동일하지 않게** 한다(`any(mock_modules)` 분기 자체를 제거).
  2. 비교를 `p.new is mock_sentinel or p.new is ut_mock_sentinel`로 변경 — **동일성(identity) 비교**라 `__eq__`를 전혀 호출하지 않으므로 numpy류 객체에서도 안전.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `TestMockDecoration::test_mock_sentinel_check_against_numpy_like`. `__eq__`에서 `ValueError("...cannot compare against others for truth")`를 던지는 `NumpyLike` 클래스를 만들고, 그 인스턴스를 `@patch(..., new=dummy.NumpyLike(50))`로 패치한 테스트를 `inline_run`으로 수집·실행해 `assertoutcome(passed=1)`을 기대. 픽스 전엔 수집 단계에서 `num_mock_patch_args`가 `__eq__`를 호출해 `ValueError`로 죽고, 픽스 후엔 `is` 비교라 `__eq__`를 건드리지 않아 통과.
- **픽스 증명**: 테스트가 numpy 자체가 아니라 "동등 비교 시 진리값으로 못 쓰는 객체"를 일반화한 `NumpyLike`로 짜여 있어, identity 비교로 바뀐 것을 정확히 겨냥한다. docstring도 "compares against sentinels using identity"라 의도를 명시.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 테스트가 numpy를 흉내낸 합성 객체로 **원인 클래스를 일반화**해 special-case 통과를 어렵게 만든다. 다만 "예외를 던지는 `__eq__`"만 검증하므로, `__eq__`가 예외 없이 비-bool을 반환하는 케이스(진짜 numpy 배열)는 미검증 — identity로 고치면 자동 커버되나, 동등성 기반 우회 픽스라면 통과만 노린 overfit이 가능(`overfit-risk`는 약함).
- **regression 관점**: P2P의 `test_unittest_mock`, `test_unittest_mock_and_fixture`, `test_getfuncargnames_patching` 등이 실제 mock 센티넬 경로(`p.new`가 진짜 `DEFAULT`인 경우)를 커버하므로, identity 비교가 정상 mock 인자 카운팅을 깨지 않음을 보증한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 스택트레이스 마지막 프레임(`compat.py:94: in <listcomp> ... if not p.attribute_name and p.new in sentinels`)과 명시된 회귀 커밋이 `num_mock_patch_args`를 직접 가리킨다. 추가 탐색 없이 그 함수만 연다.
2. **픽스와 일반화**: 근본은 "센티넬 멤버십을 `==` 기반 `in`으로 한 것". 센티넬은 **고유 객체와의 동일성**으로만 의미가 있으므로 `is` 비교가 정답. 동시에 모듈 미import 시 분기를 없애고 `getattr(..., object())` 더미 센티넬로 fallback해 "절대 안 맞음"을 보장 — 이는 numpy뿐 아니라 `__eq__`가 비-bool/예외를 내는 모든 객체에 통하는 올바른 일반화다(특정 타입 white-list가 아님).
3. **regression 안전**: 진짜 `unittest.mock.DEFAULT`/`mock.DEFAULT`로 패치한 인자는 여전히 카운트돼야 한다. P2P의 mock 관련 테스트들이 이를 지키며, identity 비교는 동일 sentinel 객체에 대해 정확히 동작하므로 안전.
4. **함정 회피**: (a) `try/except`로 `in` 비교를 감싸 ValueError만 삼키는 미봉책 — 다른 비-bool 반환 객체는 여전히 오작동하므로 틀림. (b) `isinstance`로 numpy 배열만 특수처리 — numpy 의존 도입 + 일반화 실패. (c) 모듈 미import fallback을 빼고 `is` 만 바꾸면 sentinel이 `None` 등으로 새서 우연 매칭 위험 — 원본 패치가 `object()` 더미로 막는 부분을 놓치기 쉬운 함정. 정답은 "identity 비교 + 항상 비교 가능한 sentinel 보장" 두 축을 함께 잡는 것.
