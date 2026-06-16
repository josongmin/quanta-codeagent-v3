---
instance_id: pydata__xarray-6992
repo: pydata/xarray
base_commit: 45c0a114e2b7b27b83c9618bc05b36afac82183c
version: "2022.06"
difficulty: ">4 hours"
created_at: 2022-09-05T15:07:43Z
fail_to_pass: 12
pass_to_pass: 945
gold_files: [xarray/core/dataset.py, xarray/core/indexes.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

## 문제 요약

index refactor(#5692) 이후 `Dataset`이 `_variables`보다 `_coord_names`를 더 많이 가질 수 있게 되면서 `DataVariables.__len__`이 음수를 반환해 `ValueError: __len__() should return >= 0`로 repr 등이 깨진다. 근본은 `set_index`/`reset_index`가 인덱스를 제거할 때 deindex된 좌표를 변수 집합에서 같이 떨어뜨리거나(coord_names에는 남김) 베이스 변수로 변환하지 못하는 것. MVCE는 `set_index(z=['a','b']).reset_index("z", drop=True)`로 `_coord_names`/`_variables` 카운트 불일치를 만든다.

## 유형 (정형화)

- **L = L3 (Multi-site)**: 픽스가 `dataset.py`의 `set_index`·`reset_index` 두 함수 + `indexes.py`의 `PandasMultiIndex.keep_levels`를 **함께** 재작성해야 성립. 한 곳만 고치면 변환/이름변경 계약이 어긋남.
- **S = S6 (+S2)**: 한 줄 가드가 아니라 collect-then-process 형태의 구조 변경. `maybe_drop_indexes`(list) → `drop_indexes`/`drop_variables`(set)로 자료구조를 바꾸고, deindex된 좌표를 `to_base_variable()`로 재주입하는 새 단계를 추가. multi-index 레벨 보존 분기(드롭/변환/이름변경 3-way)는 불변식 추론(S2)이 보조로 필요.
- **K = K-Domain**: xarray 내부의 index/coordinate/IndexVariable vs Variable 구분, `xindexes.get_all_coords`, `PandasMultiIndex`/`PandasIndex`, `_coord_names` 불변식을 알아야 한다. 일반 파이썬 추론으로는 불가.
- **primary = T-DomainBound**: 진짜 병목은 "어디"가 아니라(repr 스택트레이스가 L368을 지목) index refactor 도메인 모델 위에서 좌표 lifecycle을 올바르게 재설계하는 지식. 그래서 strategy는 G&V가 아닌 구조-refactor.

## 난이도 티어

**T5 (어려움).** 구조적 피처: 2파일·3함수, 골드 ~110줄 멀티헌크, deindex 좌표 변환이라는 비자명 불변식, F2P=12 / **P2P=945**의 넓은 regression-trap. localize는 has-repro(스택트레이스가 `dataset.py:368` 지목) 덕에 증상 진입점은 쉬우나, 원인 함수(`set_index`/`reset_index`)는 거기서 데이터플로우를 거슬러 올라가야 해 L3에 가깝다. 공식 라벨은 **>4 hours**(=T6 prior). 한 단계 낮춘 이유: 골드가 단일 슬라이스(인덱스 lifecycle) 안에 모이고 100줄 근방·2파일이라 ICLR 컷의 "≥3파일/>>100줄 → <10%" 최악 구간엔 못 미친다. 다만 multi-index 레벨 보존(드롭/변환/이름변경) 분기를 틀리면 P2P 대량 회귀라 T4로 더 내리진 않는다.

## 골드패치 분석

- **`Dataset.set_index`** (`dataset.py`): 누적 자료구조를 list→set으로 교체(`drop_indexes`, `drop_variables`, `all_var_names`). 인덱스에 딸린 좌표(`index_coord_names`)를 같이 drop 대상에 넣되, 루프 후 **`drop_variables` 중 새 변수도 입력 변수도 아니고 기존 좌표인 것은 `to_base_variable()`로 재주입**(deindexed 좌표 보존). 단일 var_name 케이스에선 `dim`을 drop에서 빼 좌표 순서를 유지. 최종 `coord_names = self._coord_names - drop_variables | set(new_variables)`.
- **`Dataset.reset_index`** (`dataset.py`): 헬퍼 `drop_or_convert(var_names)` 도입 — `drop`이면 버리고 아니면 `to_base_variable()`로 변환. `seen` set으로 multi-index 중복 처리 방지. `PandasMultiIndex`는 (a) 일부 레벨 유지→`keep_levels`로 새 인덱스, 단일로 축소되면 backward-compat로 레벨좌표를 dim으로 rename, (b) 그 외엔 dim 변수 항상 drop. 반환을 `_replace`→`_replace_with_new_dims`로 바꿔 dims 재계산.
- **`PandasMultiIndex.keep_levels`** (`indexes.py`): 레벨이 하나로 줄어 `PandasIndex`로 강등될 때 `index.rename(self.dim)`으로 **레벨좌표 이름을 차원명으로 변경**(backward compat).
- **근본원인**: deindex된 좌표가 `_variables`에서 빠지는데 `_coord_names`엔 남아 카운트 불일치 → `DataVariables.__len__` 음수.

## 검증 (test_patch)

FAIL_TO_PASS 12개: `test_reset_index`(DataArray/Dataset)는 reset 후 옛 dim 좌표가 사라지고 레벨좌표가 base Variable로 변환됨을 기대(`to_base_variable()` 비교). 신규 `test_reset_index_drop_dims`(drop=True면 dim 0개), `test_reset_index_drop_convert`(8개 parametrize)는 dropped/converted/renamed 3-축을 전수로 검증 — multi-index 레벨/차원 좌표가 정확히 드롭·변환·rename되는지. `test_set_index_deindexed_coords`(#6969)는 deindex 좌표가 base 변수로 보존됨을. `test_groupby_drops_nans`는 reset_index가 이제 좌표를 알아서 정리해 수동 `.drop_vars(["lon","lat"])`가 불필요해짐.

- **overfit 관점**: 8-way parametrize가 drop×인자조합 공간을 거의 채워 special-case 통과 여지가 작다. attrs 보존 테스트(`assert obj.coord_1.attrs == da.coord_1.attrs`)까지 추가돼 변환 경로가 메타데이터를 보존하는지도 잠근다.
- **regression 관점**: P2P 945로 매우 넓다. reset/set 좌표 lifecycle을 건드리므로 stack/unstack/groupby/repr 전반을 안 깨야 한다. `_replace`→`_replace_with_new_dims` 전환이 dim 재계산 회귀의 핵심 안전장치.

## 모범답안 (오라클 기반)

1. **localize 경로**: 스택트레이스가 `DataVariables.__len__`(dataset.py:368)을 지목 → 거기서 `len(self._dataset._variables) - len(self._dataset._coord_names)` 불변식이 깨짐을 확인 → MVCE의 `set_index().reset_index(drop=True)` 역추적으로 진짜 결함은 두 메서드가 인덱스 제거 시 좌표를 `_variables`/`_coord_names`에 일관되게 반영하지 못하는 것임을 특정.
2. **픽스와 일반화**: "deindex되는 좌표는 drop이면 변수·coord_name 양쪽에서 빼고, drop이 아니면 `IndexVariable`을 `to_base_variable()`로 강등해 보존"이라는 단일 불변식을 set/reset 양쪽에 적용. 이게 special-case가 아닌 이유 — multi-index 레벨/차원/일반좌표 모든 경우를 `drop_or_convert` 한 경로로 통일하고 `keep_levels` rename으로 backward-compat까지 포함하기 때문.
3. **regression 안전**: P2P 945. `_replace_with_new_dims`로 dims를 재계산해 차원 누락을 막고, multi-index 단일강등 시 dim rename을 유지해 기존 `reset_index` 결과(레벨좌표명) 의존 코드를 보존해야 한다. `coord_names`를 set 연산으로 일관되게 계산해 다시는 음수 카운트가 안 나게.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `__len__`에 `max(0, ...)` 가드만 박아 증상만 가리거나(근본 불일치 잔존), (b) deindex 좌표를 그냥 drop해버려 `test_*_drop_convert`의 converted 케이스를 깨거나, (c) multi-index 단일강등 rename을 빠뜨려 P2P 회귀를 낸다. 회피법: repr 증상이 아니라 set/reset의 좌표 lifecycle을 SSOT로 보고, drop/convert/rename 3-way를 전수로 다루는 구조 변경으로 접근.
