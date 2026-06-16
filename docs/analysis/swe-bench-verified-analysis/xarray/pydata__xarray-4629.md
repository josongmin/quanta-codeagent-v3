---
instance_id: pydata__xarray-4629
repo: pydata/xarray
base_commit: a41edc7bf5302f2ea327943c0c48c532b12009bc
version: "0.12"
difficulty: "<15 min fix"
created_at: 2020-11-30T23:06:17Z
fail_to_pass: 1
pass_to_pass: 32
gold_files: [xarray/core/merge.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
`xr.merge([...], combine_attrs='override')`로 병합한 결과의 `attrs`가 첫 번째 소스의 attrs 딕셔너리를 **복사하지 않고 참조**한다. 그래서 병합 결과의 attr 값을 바꾸면 첫 번째 소스 객체의 attr까지 같이 바뀌는 aliasing 버그가 발생한다. 이슈 본문이 원인 라인(`return variable_attrs[0]`)과 정확한 수정안(`return dict(variable_attrs[0])`)까지 직접 적시한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 파일·라인·함수까지 지목한다 — `xarray/core/merge.py`의 `merge_attrs`, `combine_attrs == "override"` 분기, 심지어 GitHub permalink(L504)와 원인 라인까지. grep 한 방 이전에 이미 좌표가 주어짐.
- **S1 (Direct-Map)**: 정형 결함클래스(mutable-default aliasing / 방어적 복사 누락). 픽스는 기계적 — 참조 반환을 `dict(...)` shallow-copy 반환으로 교체. 추론 합성 불필요.
- **K-Gen**: xarray 도메인 지식 무관. "딕셔너리는 참조다, 복사하려면 `dict()`로 감싸라"는 순수 일반 파이썬 상식.
- **primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 템플릿(S1, 복사 누락 방어). 이슈가 사실상 패치를 적어줬으므로 T-LocTrivial에 근접하나, "찾으면 끝"보다 결함클래스 매칭(방어적 복사)이 본질이라 T-DirectMap.
- APR 관점: 같은 함수의 인접 분기(`no_conflicts`, `identical`)가 이미 `result = dict(variable_attrs[0])` 패턴을 쓰고 있어, `override` 분기만 이 일관성에서 이탈한 것. 따라서 픽스는 "주변 분기와 동일한 정규형으로 회귀"하는 template-repair(PAR/TBar류)다.

## 난이도 티어
**T1 (존나쉬움)**. 구조적 피처:
- 파일 수 1, 변경 라인 1줄(단일 토큰 wrapping). ICLR 2024 구조컷의 "1파일·<5줄 ≈ 48% solve" 최상단.
- localize 직접성 최대(L0): 이슈가 함수·라인·픽스를 모두 명시.
- `has-repro`: 복사-붙여넣기 가능한 MCVE가 있고 결정론적으로 재현됨(가장 강한 easiness 신호, ~87%).
- 도메인 지식 0(K-Gen).
- P2P 32개로 표면상 넓지만(`regression-trap` 표기), 픽스가 동작 출력은 그대로 두고 객체 정체성만 바꾸므로 인접 동작을 깰 경로가 사실상 없음 — trap의 실질 위험은 낮음.
- 공식 라벨 `<15 min fix`와 완전 일치. 재조정 불필요.

## 골드패치 분석
- **파일·함수**: `xarray/core/merge.py` → `merge_attrs(variable_attrs, combine_attrs)`.
- **근본원인**: `combine_attrs == "override"` 분기가 `return variable_attrs[0]`로 첫 소스의 attrs **딕셔너리 객체 자체**를 반환. 병합 결과의 `.attrs`가 소스와 동일 객체를 가리켜(aliasing), 결과 mutation이 소스로 전파됨.
- **수정요지**: `return dict(variable_attrs[0])`로 shallow copy를 반환. 같은 함수의 `no_conflicts`/`identical`/`drop` 분기가 이미 새 dict를 만들어 반환하는 것과 정합. 값 의미(첫 소스의 attrs 채택)는 동일하게 유지하면서 객체 공유만 끊음.

## 검증 (test_patch)
- **FAIL_TO_PASS** (`test_merge_attrs_override_copy`): `ds1(attrs x=0)`, `ds2(attrs x=1)`를 `combine_attrs="override"`로 merge한 뒤 `ds3.attrs["x"] = 2`로 바꾸고 `ds1.x == 0`을 단언. 즉 결과 mutation이 소스로 새지 않음(독립성)을 직접 관찰.
- **픽스 증명**: 패치 전엔 `ds3.attrs`가 `ds1` attrs와 같은 객체라 `ds1.x`가 2로 오염되어 단언 실패 → 패치 후 별도 dict라 `ds1.x == 0` 유지. 테스트는 버그의 핵심 인과(aliasing)를 정확히 타격.
- **overfit 관점**: 단일 테스트지만 special-case 통과 불가 — 객체 정체성 분리는 `dict()` wrapping 외 자연스러운 우회가 없음. shallow copy라 nested mutable attr까진 안 막지만, 골드도 동일 범위라 over/under-fit 아님.
- **regression 관점**: P2P 32개에 `override` 출력 동등성 테스트(`test_merge_arrays_attrs[override-...]`)가 포함되어 값 의미 보존을 강제. `dict()`는 키·값을 그대로 복제하므로 통과. 동작 출력은 불변, 정체성만 바뀌어 회귀 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 제목의 "combine_attrs='override' does not copy attrs" + 본문이 명시한 `merge.py` L504와 `return variable_attrs[0]`을 그대로 따라간다. `merge_attrs` 함수로 직행 — 탐색 비용 거의 0.
2. **픽스**: `return variable_attrs[0]` → `return dict(variable_attrs[0])`. 올바른 일반화인 이유: 버그의 본질은 "값이 틀림"이 아니라 "반환 객체가 소스와 공유됨"이다. 인접 분기들이 모두 `dict(...)`로 새 객체를 만드는 함수 내부 관례가 이미 존재하므로, `override`만 그 관례로 정렬하는 것이 minimal·consistent한 수정. 특수 케이스 하드코딩이 아님.
3. **regression 안전**: `override` 분기의 출력 값(첫 소스 attrs 채택)은 그대로여야 하고 `test_merge_arrays_attrs[override-...]`가 이를 보증. `dict()`는 얕은 복제로 키/값 동일성을 유지하므로 안전. 다른 `combine_attrs` 분기는 손대지 않아 영향 없음.
4. **함정 회피**: (a) 과잉 수정 — `copy.deepcopy`를 쓰면 골드보다 넓어지고 큰 attrs에서 성능 회귀 우려; shallow `dict()`로 충분(소스 dict 재바인딩만 막으면 됨). (b) 잘못된 위치 — 호출부(`merge_core`/`Dataset` 생성)에 복사를 넣으면 분기 일관성을 깨고 다른 경로에 부작용. 원인 라인 한 곳만 고치는 게 정답. (c) 단언 방향 혼동 — 테스트는 "결과 변경이 소스에 안 샌다"이지 "소스 변경이 결과에 안 샌다"가 아님(override는 어차피 소스 dict 채택). 인과 방향을 결과→소스로 정확히 잡아야 함.
