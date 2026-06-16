---
instance_id: pydata__xarray-4094
repo: pydata/xarray
base_commit: a64cf2d5476e7bbda099b34c40b7be1880dbd39a
version: "0.12"
difficulty: "<15 min fix"
created_at: 2020-05-26T00:36:02Z
fail_to_pass: 1
pass_to_pass: 862
gold_files: [xarray/core/dataarray.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`DataArray.to_stacked_array` → `to_unstacked_dataset` 라운드트립이 변수가 단일 차원(예: `("x",)`)일 때 깨진다. MCVE에서 `MergeError: conflicting values for variable 'y'`가 발생한다. 다차원 변수에서는 정상이지만, 변수가 stack 차원(`y`) 외의 추가 차원을 갖지 않으면 셀렉션 결과에 좌표 `y`(스칼라)가 남아 각 sub-DataArray가 서로 다른 `y` 값을 들고 와 최종 `Dataset(data_dict)` 결합 시 충돌한다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 `to_unstacked_dataset` 메서드를 함수명으로 직접 지목한다. `dataarray.py`의 해당 메서드 본문은 짧아 grep+약간의 탐색으로 수렴한다. 단일 함수이므로 L0에 가깝지만, 버그 라인이 메서드 이름 자체가 아니라 내부 `self.sel(...)` 호출의 인자라는 점에서 L1.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점(`self.sel({variable_dim: k})`)은 명확하나, 올바른 픽스는 "왜 `y` 좌표가 남는가 → squeeze로는 좌표가 안 떨어진다 → 셀렉션 시점에 indexer 좌표를 drop해야 한다"는 불변식 추론을 요구한다. 기계적 None-가드/상수교체가 아니라 xarray 인덱싱 의미론을 따져 `drop=True` 인자를 합성하는 일이라 S2.
- **K (Knowledge) = K-Domain**: `sel`의 `drop` 인자가 indexer 스칼라 좌표를 제거한다는 것, `squeeze(drop=True)`는 길이-1 차원만 제거하지 길이-0(스칼라 비차원) 좌표는 못 떼낸다는 것 — xarray 인덱싱/좌표 도메인 지식이 병목.
- **primary_type = T-ConstraintReason**: 위치는 거의 주어졌으나 핵심 난점이 "올바른 조건/인자를 의미론으로 합성"하는 데 있음. S2가 dominant이므로 T-ConstraintReason.

APR 관점: 이슈가 픽스를 받아쓰게 해주지 않으므로(증상=MergeError만 제시) S1 Direct-Map이 아니다. 후보 패치를 마구 생성해 테스트로 거르는 G&V(S3/S4)보다, `sel` 좌표 의미론 1개를 추론해 `drop=True`를 추가하는 SemFix류 단일 조건합성이 정확한 분류다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개, 함수 1개, 실질 변경 1줄 → scope는 T1~T2급.
- `has-repro`: MCVE가 정확한 재현 + 기대 동작("working roundtrip")을 제시 → 강한 easiness 신호.
- 그러나 픽스 자체가 자명하지 않다: `squeeze(drop=True)`가 이미 있는데도 안 되는 이유를 이해하려면 "스칼라 비차원 좌표"와 "길이-1 차원" 구분이라는 도메인 추론이 필요. 단순 None-가드였다면 T2.
- `regression-trap`: P2P 862개로 광범위하고, 같은 메서드의 기존 다차원 경로(`create_test_stacked_array` 기반 테스트)를 깨면 안 됨. `drop=True`가 다차원 케이스의 정상 좌표를 잘못 떨구지 않아야 한다.

공식 라벨은 `<15 min fix`(T1~T2 prior). 1줄 수정·repro 존재는 이에 부합하나, 픽스의 인과(squeeze로는 못 떼는 좌표를 sel 단계에서 drop)를 "추론"해야 하고 regression 표면이 넓어 T3로 한 단계 올린다. 개발자에겐 15분이지만 오라클 없는 에이전트에겐 "왜 squeeze가 실패하는가" 진단이 비자명.

## 골드패치 분석
- **파일·함수**: `xarray/core/dataarray.py`의 `DataArray.to_unstacked_dataset(self, dim, level=0)`.
- **근본원인**: 변수별 슬라이스 추출 루프
  ```python
  data_dict[k] = self.sel({variable_dim: k}).squeeze(drop=True)
  ```
  에서 `self.sel({variable_dim: k})`는 MultiIndex 레벨 `variable_dim`을 `k`로 선택하면서 stack 차원 `dim`(=`y`)에 해당하는 **스칼라 좌표 `y`를 결과에 남긴다**. 변수가 다차원이면 남은 다른 차원 덕에 `squeeze(drop=True)`로 정리되지만, 단일 차원 변수는 선택 후 0-차원이 되며 스칼라 `y` 좌표가 비차원 좌표로 잔존한다. 이 `y` 값이 변수마다 달라, 마지막 `return Dataset(data_dict)`에서 좌표 정렬/결합 시 `MergeError: conflicting values for variable 'y'`로 터진다.
- **수정요지**: 셀렉션 시점에 indexer 좌표를 떨군다 — `self.sel({variable_dim: k}, drop=True)`. `sel`의 `drop=True`는 스칼라 인덱서로 인해 생긴 차원 좌표를 결과에서 제거하므로 잔존 `y` 좌표가 애초에 생기지 않는다. 뒤따르는 `.squeeze(drop=True)`는 길이-1 차원 정리용으로 그대로 유지.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_to_stacked_array_to_unstacked_dataset`에 단일차원 회귀 케이스가 추가됨(GH4049 주석). `arr = DataArray(arange(3), coords=[("x",[0,1,2])])` → `Dataset({"a":arr,"b":arr})` → `to_stacked_array("y", sample_dims=["x"])` → `to_unstacked_dataset("y")`가 `assert_identical(unstacked, data)`로 원본과 동일해야 한다. 픽스 전엔 MergeError로 실패, `drop=True` 추가 후 통과.
- **픽스 증명**: 추가 케이스가 정확히 "stack 차원 외 추가 차원이 없는" 경계 입력을 친다 → 버그의 원인(잔존 스칼라 `y` 좌표)을 직접 트리거. `drop=True`가 좌표를 제거해 round-trip identity가 성립.
- **overfit 관점**: 같은 테스트의 기존 2차원 블록(`create_test_stacked_array`)이 유지되어 단일/다차원 양쪽을 함께 검증 → special-case 통과로 빠져나갈 여지 적음. F2P는 1개로 얇지만 같은 함수의 일반 경로를 P2P/동일 테스트가 동시에 지킨다.
- **regression 관점**: 다차원 경로에서 `drop=True`는 정상적으로 존재하는 좌표를 떨구지 않는다(인덱서가 만든 스칼라 좌표만 대상). P2P 862 + 기존 2차원 assert가 회귀 방지선. 핵심은 `squeeze(drop=True)`를 `drop=True`로 **교체하지 않고 추가**했다는 점.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `to_unstacked_dataset`를 직접 호명 → `dataarray.py`에서 메서드를 연다. MergeError 메시지("conflicting values for variable 'y'")가 stack 차원명 `y`를 가리키므로, 결과를 합치는 `Dataset(data_dict)` 앞 `data_dict[k] = ...` 라인이 용의자. 단일차원에서만 깨진다는 단서로 "다차원에서 squeeze가 정리하던 것이 단일차원에선 안 남나"를 본다.
2. **픽스와 일반화 근거**: `self.sel({variable_dim: k})`가 스칼라 인덱서로 인해 `y` 좌표를 남긴다는 것을 진단하고, `sel(..., drop=True)`로 인덱서 좌표를 셀렉션 단계에서 제거. 이는 단일차원만 특별처리(예: `if`로 차원수 분기)하는 overfit이 아니라, **모든 케이스에서 인덱서 좌표를 떨구는** 의미론적으로 올바른 일반화 — 다차원 케이스도 어차피 그 `y` 좌표가 불필요했다.
3. **regression 안전**: 기존 2차원 라운드트립(`create_test_stacked_array`), 그리고 `to_stacked_array`/`to_unstacked_dataset` 관련 P2P를 안 깨야 한다. `drop=True`는 인덱서가 생성한 좌표에만 작용하므로 정상 데이터 좌표를 손상시키지 않음 → 다차원 assert가 그대로 통과.
4. **함정 회피**: (a) `.squeeze(drop=True)`를 지우거나 `.squeeze()`만으로 고치려는 시도 — squeeze는 차원을 떼지 비차원 스칼라 좌표를 못 떼므로 실패. 픽스는 squeeze가 아닌 sel 쪽이다. (b) 단일차원 분기(`if k.ndim==0: ...`)로 특수처리하는 overfit — F2P는 통과해도 의미론적으로 더럽고 다른 경계에서 재발. (c) 출력에서 `y` 좌표를 사후 `drop_vars`로 떼는 임시방편 — 근본원인(잔존 좌표 생성)을 안 막아 부작용 위험. 올바른 답은 발생 지점에서 `sel(..., drop=True)`로 막는 것.
