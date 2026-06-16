---
instance_id: sympy__sympy-14711
repo: sympy/sympy
base_commit: c6753448b5c34f95e250105d76709fe4d349ca1f
version: "1.1"
difficulty: "<15 min fix"
created_at: "2018-05-12T17:00:20Z"
fail_to_pass: 1
pass_to_pass: 2
gold_files: [sympy/physics/vector/vector.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, overfit-risk]
---

## 문제 요약

`sympy.physics.vector`의 `Vector`를 파이썬 내장 `sum([N.x, 0*N.x])`으로 더하면 `TypeError: A Vector must be supplied`가 난다. `sum`은 초기값 `0`(정수)부터 누적하므로 `Vector.__add__(self, 0)`이 호출되는데, `__add__`가 곧장 `_check_vector(other)`로 넘겨 `0`이 `Vector` 인스턴스가 아니라 예외를 던진다. 즉 가산 항등원(`0`)을 흡수하는 처리가 빠져 있다.

## 유형 (정형화)

- **L (Localization) = L0**: 이슈에 네이티브 스택트레이스가 그대로 들어 있고, `vector.py`의 `__add__` 60번 줄 `#if other == 0: return self` 주석까지 가리킨다. 고칠 심볼이 문자 그대로 지목됨.
- **S (Repair) = S1 (Direct-Map)**: 정형 결함클래스 "가산 항등원(0) 미처리"의 템플릿 그 자체. 픽스는 `other == 0` 가드 추가로 기계적. 추론 합성 불필요.
- **K (Knowledge) = K-Domain**: 일반 파이썬으로 버그 현상은 보이나, 왜 `0`이 들어오는지(`sum`의 start=0 누적)와 "올바른 항등원 동작은 `self` 반환"이라는 점은 sympy의 가산 의미론 맥락에서 판단해야 한다. 다만 의존도는 얕음.
- **Primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 가드 한 줄(S1)인 전형적 직접매핑. T-LocTrivial이 아닌 이유는 "0을 흡수해 self를 반환"이 가산 항등원이라는 도메인 의미를 살짝 요구하기 때문(순수 K-Gen 자명 픽스보다 한 칸 위).
- repair strategy 근거(APR): 결함이 None/항등원 가드 누락이라는 정형 패턴 → PAR/TBar식 템플릿 매칭으로 바로 픽스. 후보 다수 탐색(S3)이나 식 합성(S2)이 아니다.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`vector.py`), 함수 1개(`__add__`), 실질 +2줄(가드).
- localize 직접성 최상: 스택트레이스 + 코드에 주석 힌트(`#if other == 0: return self`)까지 존재 → `has-repro`.
- P2P trap 약함: PASS_TO_PASS가 `test_Vector_diffs`, `test_vector_var_in_dcm` 2개뿐. 인접 동작 깰 면적 작음.
- 도메인 부담 얕음(가산 항등원 정도) → K-Domain이지만 병목 아님.

공식 라벨 `<15 min fix`와 일치. T1로 더 내리지 않는 이유는 픽스가 순수 일반 추론(K-Gen)이 아니라 "0=항등원→self" 의미 판단을 끼고, `0 == self`가 아닌 `self == 0` 방향(피연산자 순서)·`__radd__` 미커버라는 잠재 함정이 한 칸 더 무겁기 때문.

## 골드패치 분석

- **파일/함수**: `sympy/physics/vector/vector.py`의 `Vector.__add__`.
- **근본원인**: `__add__`가 입력을 무조건 `_check_vector(other)`로 검증하는데, `_check_vector`는 `isinstance(other, Vector)`가 아니면 `TypeError('A Vector must be supplied')`를 던진다. `sum()`의 시작 누적값 정수 `0`(가산 항등원)을 가산 항등원으로 흡수하지 않아 검증에서 탈락.
- **수정요지**: `_check_vector` 호출 전에 가드 추가.
  ```python
  if other == 0:
      return self
  ```
  주석으로만 남아 있던 의도(`#if other == 0: return self`)를 활성화한 것. `0`이면 자기 자신을 반환해 항등원 법칙 `v + 0 == v`를 만족시킨다.

## 검증 (test_patch)

- **FAIL_TO_PASS = `test_Vector`**: `assert A.x + 0 == A.x` 한 줄 추가. 픽스 전엔 `A.x + 0`이 `TypeError`로 죽어 테스트 수집조차 실패, 픽스 후 가드가 `self`를 반환해 통과.
- **픽스 증명**: `A.x + 0` → `__add__(A.x, 0)` → `other == 0` 참 → `return self`(=`A.x`) → `A.x == A.x` 참. 인과가 패치와 정확히 일치.
- **overfit 관점**: `flags: overfit-risk`. 테스트가 단일 단언(`A.x + 0 == A.x`)이라 얇다. `other == 0` 가드는 `0` 정수뿐 아니라 `__eq__`상 0과 같은 모든 객체(예: `0*A.x` 같은 영벡터가 `0`과 같다고 평가되면)도 흡수하는데, 이 일반화가 우연히 옳다(영가산항등원). 단 좌변이 정수인 `0 + N.x` 경로(`__radd__`)는 이 테스트가 검증하지 않아 미커버 — special-case 통과 여지 존재.
- **regression 관점**: P2P 2개(`test_Vector_diffs`, `test_vector_var_in_dcm`)는 정상 벡터-벡터 가산·미분 경로라 `other == 0` 분기에 안 걸려 byte-동작 불변. 안전.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 스택트레이스가 `vector.py __add__` → `_check_vector` 710줄 `raise TypeError`로 곧장 지목. `sum([N.x, 0*N.x])`의 `sum`이 정수 `0`부터 누적함을 인지하면 "`Vector + 0` 미처리"로 즉시 수렴. 코드 내 주석 `#if other == 0: return self`가 의도까지 못 박아 줌 → L0.
2. **픽스와 일반화 정당성**: `_check_vector` 호출 직전 `if other == 0: return self` 가드. 이는 가산 항등원 법칙 `v + 0 = v`의 구현이라 special-case가 아닌 수학적으로 올바른 일반화다. `0`만 좁게 처리하지, 다른 비-Vector 입력은 여전히 `_check_vector`가 거부해 타입 안전성 유지.
3. **regression 안전**: 정상 `Vector + Vector` 경로는 `other == 0`이 거짓이라 기존 `_check_vector`/`Vector(self.args + other.args)` 흐름 그대로. P2P(diffs, dcm)가 이 경로만 쓰므로 영향 없음.
4. **함정 회피**: (a) `0 == self` 대신 `self == 0`처럼 비교 방향을 뒤집어 `Vector.__eq__`가 비-Vector 0과의 비교에서 다시 예외/오판을 내지 않도록 주의 — 골드는 `other == 0`(파이썬이 `int.__eq__(0, other)` → `Vector.__eq__`로 위임)으로 안전. (b) 가드를 `_check_vector` *이후*에 두면 이미 예외가 나서 무의미 — 반드시 검증 전. (c) 과욕으로 `__radd__`/스칼라 곱셈까지 손대면 scope를 넘어 regression 위험만 키운다 — 오라클은 `__add__` 한 곳·두 줄로 충분.
