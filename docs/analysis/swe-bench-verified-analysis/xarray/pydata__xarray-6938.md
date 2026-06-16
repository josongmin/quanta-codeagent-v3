---
instance_id: pydata__xarray-6938
repo: pydata/xarray
base_commit: c4e40d991c28be51de9ac560ce895ac7f9b14924
version: "2022.06"
difficulty: "15 min - 1 hour"
created_at: 2022-08-20T16:45:22Z
fail_to_pass: 1
pass_to_pass: 430
gold_files: [xarray/core/dataset.py, xarray/core/variable.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약

`Dataset.swap_dims()`가 특정 경로에서 원본 객체를 in-place로 변형시킨다. 데이터 변수를 차원 좌표 변수로 swap할 때, 결과 변수의 `.dims`를 바꾸는 작업이 원본의 데이터까지 전파되어 `ds2['lev']`의 차원이 의도치 않게 `'lev'`로 바뀐다. 사용자는 함수형(비파괴적) 동작을 기대했다. MVCE가 첨부되어 재현이 가능하다.

## 유형 (정형화)

- **L = L1 (Traceable)**: 이슈가 `swap_dims`를 직접 지목하나, 진짜 버그는 그 안에서 호출되는 `v.to_index_variable()`가 별칭(self)을 반환하는 데 있어 한 단계 데이터플로우 추적이 필요하다. grep 한 방은 아니지만 단일 좁은 후보로 수렴한다.
- **S = S2 (Constraint-Reasoning)**: 픽스 지점은 좁지만, "왜 원본이 변하는가"는 불변식(value-semantics: 변환 메서드는 새 객체를 반환해야 한다) 추론으로 합성해야 한다. 단순 None-가드/상수변경이 아니라 aliasing 불변식 위반을 짚는 의미적 추론이다.
- **K = K-Domain**: `Variable` vs `IndexVariable`의 클래스 계층, `to_index_variable`/`to_base_variable`의 fastpath 생성 관례, `IndexVariable.to_index_variable`가 base와 달리 `self`를 반환하던 xarray 내부 설계를 알아야 한다.
- **primary = T-ConstraintReason**: 위치는 거의 명확하나, 올바른 수정(`self` → `self.copy()`)이 "복사 불변식"이라는 의미 추론에서 나온다.

APR 관점: 후보 패치가 다수 떠오르지 않고(`swap_dims` 안에서 분기를 늘리는 오답 유혹은 있으나), 정답은 aliasing 불변식 한 줄 수정이라 SemFix/Angelix 식 semantic reasoning이 dominant → S2.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일 2개지만 핵심 픽스는 `variable.py` 1개 함수(`IndexVariable.to_index_variable`)의 `return self` → `return self.copy()` 한 줄. 나머지는 전부 타입 어노테이션(`-> IndexVariable`, `-> pd.Index`, `NoReturn`)과 `self.dims` → `self._dims` 같은 cosmetic/안전 변경이다.
- has-repro(MVCE 존재)는 easiness 신호지만, 버그가 `swap_dims` 표면이 아니라 한 단계 아래 변환 메서드의 aliasing에 있어 localize에 약간의 추론 부담이 있다.
- P2P 430개 — `test_variable.py` 전체가 인접 동작이라 regression-trap이 실재한다. `to_index_variable`은 copy/concat/multiindex 경로에서 광범위하게 쓰이므로 잘못 복사하면 대량 회귀.

공식 라벨 "15min-1hour"와 부합. L1+S2+넓은 P2P가 T2(쉬움) 위로 밀지만, 실제 패치 델타가 한 줄 의미수정이라 T4까지는 못 올라가 **T3**.

## 골드패치 분석

- **건드린 함수**: `IndexVariable.to_index_variable` (`xarray/core/variable.py`) — 핵심. 부수적으로 `Variable.to_base_variable`/`to_index_variable`/`to_index`, `IndexVariable.to_index`/`level_names`/`name`, `Dataset.swap_dims`(`var: Variable` 어노테이션만).
- **근본원인**: `IndexVariable.to_index_variable`가 `return self`로 **자기 자신(별칭)을 반환**했다. `swap_dims`의 `var = v.to_index_variable(); var.dims = dims` 흐름에서, `var`가 원본 `v`와 동일 객체라 `var.dims = dims`가 원본의 dims까지 바꿔 in-place 오염이 발생.
- **수정요지**: `return self` → `return self.copy()`. 이제 변환은 항상 독립된 새 객체를 반환하므로 호출측의 `var.dims = dims`가 원본을 건드리지 않는다. 또한 base 클래스 메서드의 `self.dims` → `self._dims` 직접 접근으로 property setter 우회(안정화), 나머지는 반환형 타입 힌트 보강.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `TestIndexVariable::test_to_index_variable_copy`. `a = IndexVariable("x", ["a"]); b = a.to_index_variable()` 후 `assert a is not b`(별칭 아님)와 `b.dims = ("y",); assert a.dims == ("x",)`(독립성)을 검사. `return self`였으면 `a is b`라 첫 assert부터 실패 → 픽스로 통과.
- **픽스 증명**: 테스트가 정확히 aliasing 불변식(identity 분리 + 변형 격리)을 직접 단언하므로 `self.copy()` 수정과 1:1 대응. swap_dims 표면이 아닌 근본 메서드 레벨에서 검증해 견고.
- **overfit 관점**: 테스트가 `is not` + 독립 변형 두 각도를 보므로 `copy()`를 deepcopy로 과하게 하거나 얕게 별 객체만 만들고 dims를 공유하는 식의 special-case는 통과 못 함. overfit 위험 낮음.
- **regression 관점**: P2P 430개(copy/concat/multiindex/to_index 전부)가 그대로 통과해야 함. `copy()`가 데이터를 불필요 복제하거나 attrs/encoding을 누락하면 다수 깨짐 → 안전망 충분.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "swap_dims가 원본 modify"와 MVCE에서 `ds2['lev'].dims`가 변한다는 점 → `Dataset.swap_dims` 본문을 읽고 `var = v.to_index_variable(); var.dims = dims` 라인 발견 → `var.dims=` 대입이 원본을 바꾸려면 `var`가 `v`의 별칭이어야 함 → `IndexVariable.to_index_variable`가 `return self`임을 확인.
2. **픽스**: `return self` → `return self.copy()`. 변환 메서드는 항상 새 객체를 반환한다는 value-semantics 불변식 회복. `swap_dims`에 방어적 copy를 끼워넣는 대신 **결함 발생지점**을 고치는 것이 올바른 일반화 — base 클래스 `Variable.to_index_variable`는 이미 새 객체를 만들었으므로, 서브클래스의 별칭 반환이 계약 위반이었다.
3. **regression 안전**: `to_index_variable`이 쓰이는 모든 경로(P2P 430)에서 attrs/encoding/data가 보존되도록 `copy()`(기존 메서드)를 그대로 재사용 — 새 복사 로직을 작성하지 않는다. `test_copy_index`, `test_multiindex`, `test_concat*`가 가드.
4. **함정 회피**: 오라클 없는 에이전트가 (a) `swap_dims` 쪽에 `v.to_index_variable().copy()`처럼 호출측에 땜질하면 다른 별칭 경로를 놓침, (b) `var.dims = dims` 대입 자체를 피하려다 차원 매핑 로직을 깨뜨림. 정답은 변환 메서드의 aliasing이 근본임을 인지하고 `self.copy()` 한 줄로 일반화하는 것. 또 `self.dims` setter가 `IndexVariable`에서 막혀있는 점(`name.setter`가 `NoReturn`)을 보고 base 메서드의 `self._dims` 직접 접근이 더 안전함을 함께 챙기면 완성도가 높다.
