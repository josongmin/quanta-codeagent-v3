---
instance_id: sympy__sympy-17655
repo: sympy/sympy
base_commit: f5e965947af2410ded92cfad987aaf45262ea434
version: "1.5"
difficulty: "<15 min fix"
created_at: 2019-09-25T17:04:26Z
fail_to_pass: 2
pass_to_pass: 9
gold_files: [sympy/geometry/point.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [has-repro]
---

## 문제 요약
`geometry.Point`를 스칼라와 곱할 때 `point * 2`(우측 곱)는 동작하지만 `2 * point`(좌측 곱)는 예외를 던진다. 좌측 곱에서는 SymPy가 `Mul(2.0, Point2D(1,1))` 같은 미평가 `Mul` 객체를 만들고, 이걸 다시 `Point`에 더하려 하면 `_normalize_dimension`이 `Mul`을 좌표 시퀀스로 해석하지 못해 `GeometryError`가 난다. 기대 동작은 `2 * point`와 `point * 2`가 동일한 결과를 내는 것이다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문 스택트레이스가 `point.py`를 직접 지목하고, 힌트가 `__rmul__`을 정의하면 된다고 명시한다. grep 한 방. 점수=L0.
- **S1 (Direct-Map)**: 픽스가 사실상 명세되어 있다. 기존 `__mul__` 옆에 위임용 `__rmul__`을 추가하는 정형 결함클래스(누락된 reflected dunder). 추론 합성 불필요. 점수=S1.
- **K-API (API-contract)**: Python 연산자 프로토콜 계약을 정확히 맞춰야 함 — `__rmul__`이 호출되는 조건(좌측 피연산자가 `NotImplemented`/미정의일 때)과 SymPy의 `Mul` 평가 상호작용을 이해해야 한다. 일반 추론(K-Gen)보다 dunder 계약 지식이 핵심. 점수=K-API.
- **primary=T-DirectMap**: 위치 명확(L0) + 기계적 픽스(S1, 누락 메서드 추가). 자명함에 가깝지만 "픽스를 적어주진" 않아 T-LocTrivial보다 한 칸 위.
- APR 관점: 이건 PAR/TBar류 **fix template "missing reflected operator → delegate to forward operator"**에 정확히 매칭된다. 후보 다수 탐색(S3)이나 식 합성(S2)이 아니라, 결정론적 템플릿 적용이라 S1이 맞다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일수=1, 변경 줄수=4(메서드 1개), 단일 헌크 → "1파일·<5줄 ≈ 48% solve" 구간.
- localize 직접성: 최상(L0). 스택트레이스 + 명시적 힌트 + `has-repro`.
- repro: 이슈에 실행 가능한 재현 코드와 네이티브 traceback 존재 → 가장 강한 easiness 신호.
- 도메인: SymPy geometry 내부지식은 거의 불필요. dunder 위임이 본질이라 K-API지만 얕다.
- P2P trap: PASS_TO_PASS 9개로 좁고, `__mul__`을 건드리지 않고 메서드만 추가하므로 회귀 위험 거의 없음.

공식 라벨 `<15 min fix`와 일치(T1~T2 영역). T1이 아닌 T2인 이유: `2 * point`가 왜 실패하는지(SymPy가 `Mul` 객체를 만든다는 사실)를 이해해야 픽스 방향이 잡힌다 — 이슈가 픽스 코드를 그대로 적어주진 않는다.

## 골드패치 분석
- **건드린 파일·함수**: `sympy/geometry/point.py` — `Point` 클래스에 `__rmul__` 메서드 신규 추가(기존 `__mul__`과 `__neg__` 사이).
- **근본원인**: `Point.__mul__`만 정의되어 있고 `__rmul__`이 없다. `2.0 * point2`에서 좌측 피연산자 `Float.__mul__`이 `Point`를 처리하지 못해 Python이 `Point.__rmul__`을 찾지만 미정의라, SymPy의 일반 `Mul` 평가가 개입해 `2.0*Point2D(1,1)`이라는 미평가 `Mul`을 만든다. 이후 `__add__` → `_normalize_dimension` → `Point(Mul, ...)`에서 "Expecting sequence of coordinates, not `Mul`"로 터진다.
- **수정요지**: `__rmul__(self, factor)`를 추가해 곧장 `self.__mul__(factor)`로 위임. 스칼라 곱은 교환적이므로 좌/우 곱이 동일 좌표 스케일링을 산출.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_point`, `test_point3D`. 각 테스트에 `assert 5 * p4 == Point(5, 5)` / `assert 5 * p4 == Point3D(5, 5, 5)`가 추가됨. 픽스 전에는 좌측 곱이 `Mul`을 만들어 `==` 비교가 `Point`와 동등하지 않으므로 실패(또는 후속 연산에서 예외).
- **픽스 증명**: `__rmul__`이 `__mul__`로 위임 → `5 * p4`가 `p4 * 5`와 동일한 `Point` 인스턴스를 반환 → assert 통과. 동시에 test_patch는 기존의 `assert p4*5 == Point(5,5)`(우측 곱) 라인 위치를 정리(중복 제거)했을 뿐 우측 곱 동작은 그대로 보존.
- **overfit 관점**: `__rmul__ = __mul__` 위임은 추가 테스트가 정의한 좌측 곱 전체를 일반적으로 커버 — special-case 하드코딩이 아니라 교환법칙에 기반한 올바른 일반화라 overfit 위험 낮음. 다만 2D/3D 양쪽을 테스트하므로 좌표 차원에 무관함도 검증됨.
- **regression 관점**: `__mul__`을 변경하지 않고 새 메서드만 추가 → `test__normalize_dimension`, `test_dot`, `test_transform` 등 인접 동작 무영향. PASS_TO_PASS 9개 모두 보존.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 traceback이 `point.py`의 `__add__`/`__new__`를 지목하고, 핵심 신호는 "`point * 2`는 되는데 `2 * point`는 안 된다"는 비대칭성. 이 비대칭은 Python에서 reflected operator 누락의 전형 → `Point.__mul__`은 있고 `__rmul__`이 없음을 grep으로 확인.
2. **픽스**: `__rmul__`을 추가하고 `self.__mul__(factor)`로 위임. 스칼라 곱은 교환적이므로 위임이 의미적으로 정확하다. 직접 좌표 스케일링 로직을 복붙하지 않고 `__mul__`을 재사용 → 단일 진실원 유지, 미래 `__mul__` 변경에도 자동 일관.
3. **regression 안전**: `__mul__`/`__add__`/`_normalize_dimension`을 손대지 않으므로 우측 곱·덧셈·정규화 경로 무손상. P2P의 `test_dot`, `test_transform`, `test__normalize_dimension`이 이를 보증.
4. **함정 회피**: (a) `__add__`나 `_normalize_dimension`에 `Mul` 언패킹을 추가해 증상만 막는 우회(좌표 시퀀스로 `Mul`을 파싱)는 근본원인을 비껴가고 위험한 일반화라 overfit·회귀 함정. (b) `__mul__` 자체를 바꾸려는 시도는 불필요한 회귀 위험. 올바른 최소 픽스는 누락된 reflected dunder 추가 단 하나다. 힌트가 정답을 가리키므로, 오라클 없는 에이전트도 비대칭 신호만 잡으면 정확히 수렴 가능.
