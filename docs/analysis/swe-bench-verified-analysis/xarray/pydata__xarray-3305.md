---
instance_id: pydata__xarray-3305
repo: pydata/xarray
base_commit: 69c7e01e5167a3137c285cb50d1978252bb8bcbf
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2019-09-12T19:27:14Z
fail_to_pass: 1
pass_to_pass: 653
gold_files: [xarray/core/dataset.py, xarray/core/variable.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
`DataArray.quantile(..., keep_attrs=True)`가 `keep_attrs`를 무시하고 항상 attrs 없는 결과를 반환한다. MCVE: `xr.DataArray([0,0], dims="x", attrs={'units':'K'}).quantile(.9, dim='x', keep_attrs=True).attrs`가 빈 `OrderedDict()`를 돌려준다(기대값은 `{'units':'K'}`). 힌트에서 진단되듯, 호출 체인 하단의 `Variable.quantile`이 `keep_attrs` 인자 자체를 받지 않아 임시 데이터셋의 attrs가 어디에서도 결과 변수로 전파되지 않는다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 `quantile` + `keep_attrs`를 직접 지목하고 has-repro까지 있어 grep 한두 방으로 `Dataset.quantile`→`Variable.quantile` 호출 체인에 수렴. 다만 실제 결손은 상위가 아니라 하위 `Variable.quantile`이라 한 단계 추적이 필요 → L0 아닌 L1.
- **S (Repair Strategy) = S1 (+S5)**: 픽스가 사실상 기계적 — 이미 존재하는 프레임워크 관용구(`_get_keep_attrs(default=False)` + `attrs = self._attrs if keep_attrs else None`)를 다른 reduction 메서드들과 동일하게 이식하는 템플릿 매칭이라 S1. "기본값을 무엇으로 둘지(False)"와 None→전역기본 폴백 의미는 xarray의 `keep_attrs` 계약에서 추론해야 해서 S5 보조.
- **K (Knowledge) = K-Domain**: `_get_keep_attrs` 전역 옵션 헬퍼, `Variable._attrs` 내부 속성, attrs 전파 관례는 xarray 내부 지식. 순수 파이썬 추론만으론 "올바른 기본값=False, None=전역옵션"을 못 맞춤.
- **primary_type = T-DirectMap**: 위치가 명확하고 픽스가 기존 결함클래스(누락 파라미터 + attrs 전파 관용구)에 직접 매핑되는 기계적 수정이라 DirectMap. ConstraintReason 아님 — 합성할 비자명한 식·불변식이 없다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: gold가 2파일(`dataset.py`, `variable.py`)을 건드리지만 변경 본질은 한 곳(`Variable.quantile`)이고 `Dataset.quantile`은 새 인자를 단지 forward할 뿐이라 진짜 멀티사이트 조율(L3)이 아닌 cross-file-dep. 코드 증분 ~7줄(시그니처 1, docstring, attrs 분기 3줄, 호출부 인자 1). has-repro로 재현 즉시 가능. P2P가 653개로 넓어 regression-trap 신호가 있으나, 픽스가 `keep_attrs=None` 기본을 통해 기존 동작(attrs 안 붙음)을 그대로 보존하므로 실제 깨질 위험은 낮음. 공식 라벨 "15분-1시간"과 일치 — 단일 결함, 도메인 관용구 1개만 알면 끝. 도메인 지식이 약간 필요하고 cross-file forwarding이 있어 T1은 아님.

## 골드패치 분석
- **파일·함수**: `xarray/core/variable.py::Variable.quantile`, `xarray/core/dataset.py::Dataset.quantile`.
- **근본원인**: `Variable.quantile(self, q, dim=None, interpolation="linear")`이 `keep_attrs` 파라미터를 갖지 않고 종단에서 `return Variable(new_dims, qs)`로 attrs 없이 새 변수를 만든다. 상위 `Dataset.quantile`(나아가 `DataArray.quantile`)이 사용자의 `keep_attrs`를 받아도 하위로 넘길 통로가 없어 값이 소실된다.
- **수정요지**: (1) `Variable.quantile` 시그니처에 `keep_attrs=None` 추가 + docstring 보강. (2) 종단을 `if keep_attrs is None: keep_attrs = _get_keep_attrs(default=False)` → `attrs = self._attrs if keep_attrs else None` → `return Variable(new_dims, qs, attrs)`로 변경, 즉 xarray 표준 attrs 전파 관용구 적용. (3) `Dataset.quantile`에서 `var.quantile(...)` 호출에 `keep_attrs=keep_attrs`를 forward. 함께 들어간 docstring 들여쓰기/주석 정리는 무해한 cosmetic.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_dataarray.py::TestDataArray::test_quantile`. 기존엔 numpy 버그 핑계로 skip 처리된 테스트를 활성화하고, `DataArray(self.va).quantile(q, dim=dim, keep_attrs=True)` 결과에 대해 값 동등성(`assert_allclose`)에 더해 `assert actual.attrs == self.attrs`를 추가한다 — keep_attrs 전파를 직접 단언.
- **픽스 증명**: 픽스 후 `keep_attrs=True`면 `attrs = self._attrs`가 결과 `Variable`에 실려 DataArray로 래핑돼 `actual.attrs == self.attrs`가 성립. 픽스 전엔 attrs=빈값이라 실패.
- **overfit/regression 관점**: 테스트가 `keep_attrs=True` 경로만 단언하므로 `keep_attrs=False`/`None` 경로는 F2P가 직접 보호하지 않음(약한 overfit 여지). 그러나 픽스의 기본값 분기(`None→_get_keep_attrs(default=False)`)가 정확히 기존 무-attrs 동작을 유지해 P2P 653개의 quantile 미사용/기본 경로를 안 깬다. 다만 F2P가 1개뿐이라 "True일 때만 맞춰도 통과"가 가능 — 올바른 일반화는 테스트가 아니라 도메인 관용구에서 와야 한다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 신호 `quantile` + `keep_attrs` + MCVE로 `DataArray.quantile`→`Dataset.quantile`→`Variable.quantile` 호출 체인을 grep. 힌트("Variable.quantile should have a keep_attrs argument")가 정확히 종단 결손을 지목 → `Variable.quantile`이 `keep_attrs`를 받지도, attrs를 붙이지도 않음을 확인.
2. **픽스와 일반화**: `Variable.quantile`에 `keep_attrs=None` 추가하고, 동일 클래스의 다른 reduction(`reduce` 등)이 쓰는 표준 관용구 `keep_attrs is None → _get_keep_attrs(default=False)` / `attrs = self._attrs if keep_attrs else None`를 적용. 임의 `True`/`False` 하드코딩이 아니라 전역 옵션 폴백을 쓰는 게 xarray 계약에 맞는 올바른 일반화 — 사용자 미지정 시 전역 `keep_attrs` 옵션을 따르게 된다. 상위 `Dataset.quantile` 호출에 `keep_attrs=keep_attrs` forward로 통로를 연결.
3. **regression 안전**: 기본값을 `None`(→default=False)로 둬 `keep_attrs`를 안 넘기던 기존 호출 전부가 종전과 동일하게 attrs 없는 결과를 받게 유지 → P2P 653개(특히 quantile 무관/기본 경로)를 보존. `Variable(new_dims, qs, attrs)` 3번째 인자는 attrs=None일 때 종전 `Variable(new_dims, qs)`와 동치.
4. **함정 회피**: (a) 상위 `DataArray.quantile`에만 attrs를 덧붙이고 끝내면 임시 Dataset에 attrs가 없어 동작 안 함(힌트가 경고한 바) — 반드시 종단 `Variable.quantile`을 고쳐야 한다. (b) F2P가 `True` 경로만 보므로 attrs를 무조건 복사하도록 짜면 테스트는 통과하나 `keep_attrs=False` 시맨틱을 깨 P2P/전역옵션 동작을 회귀시킴 — `if keep_attrs else None` 분기를 빠뜨리지 말 것. (c) 기본값을 `False`로 하드코딩하면 전역 `set_options(keep_attrs=True)` 계약을 무시 — `None` 센티넬 + `_get_keep_attrs`가 정답.
