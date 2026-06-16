---
instance_id: pydata__xarray-7229
repo: pydata/xarray
base_commit: 3aa75c8d00a4a2d4acf10d80f76b937cadb666b7
version: "2022.09"
difficulty: "15 min - 1 hour"
created_at: 2022-10-26T21:45:01Z
fail_to_pass: 1
pass_to_pass: 280
gold_files: [xarray/core/computation.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`xr.where(..., keep_attrs=True)`가 좌표(coordinate) 속성을 변수(variable) 속성으로 덮어쓴다. PR #6461에서 `keep_attrs`를 `lambda attrs, context: getattr(x, "attrs", {})`로 바꾼 뒤 회귀가 발생했다 — 이 콜백은 `apply_ufunc` 내부의 모든 변수(데이터 변수 + 좌표)에 일괄로 `x`의 attrs를 주입해, 예컨대 `time` 좌표의 attrs까지 데이터 변수 attrs로 갈아치운다. 기대 동작은 결과의 각 레벨(데이터 변수/좌표)에서 `x`의 *대응되는* attrs만 보존하는 것이다.

## 유형 (정형화)

- **L (Localization) = L1**: 이슈가 `xr.where` + `keep_attrs`를 직접 지목하고 PR #6461의 `lambda` 한 줄까지 hints에 명시. `where` 함수는 `xarray/core/computation.py` 단일 함수로 grep 한 방에 수렴. 다만 "왜 좌표가 덮이는지"는 `apply_ufunc` → merge 레이어 데이터플로우 이해가 필요해 L0는 아님.
- **S (Repair Strategy) = S2 (+S6)**: 고칠 지점은 명확하나, 올바른 동작을 "추론으로 합성"해야 한다. 콜백 기반 일괄 주입을 버리고 *결과 객체 타입(Dataset/DataArray/Variable)별로 레벨을 나눠* attrs를 재구성하는 불변식을 세워야 한다. 단순 가드 추가가 아니라 콜백 제거 + 후처리 블록 도입이라는 소규모 구조 변경(S6)을 동반.
- **K (Knowledge) = K-Domain**: xarray의 attrs 전파 모델, `apply_ufunc`의 `keep_attrs` 시맨틱, Dataset/DataArray의 `data_vars`/`coords` 구조, scalar 승격(promotion) 규칙을 알아야 정확한 픽스 가능.
- **primary type = T-ConstraintReason**: 위치는 잡혀 있고(L1), 핵심 난점은 attrs 보존 불변식을 케이스별로 추론·합성하는 데 있다. APR 관점에서 콜백을 안의 `attrs[1]` 인덱싱이 scalar일 때 깨진다는 점을 추론해 "결과 구축 후 x의 attrs를 레벨별 복사"로 재설계하는 SemFix/Angelix 계열 의미 수리.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개·함수 1개(`where`)지만 순 추가 ~22줄의 멀티-케이스 분기(Dataset 승격 / 일반 / coords 항상 복사) → 단순 한 줄 픽스 아님.
- localize는 has-repro(MVCE + 정확한 attrs 기대값)와 PR 포인터로 직접적이지만, 근본원인 추적이 merge 레이어를 거쳐 비자명(이슈 본인도 "layers가 많아 못 찾겠다"고 토로).
- P2P 280개 중 `test_keep_attrs_strategies_*` 패밀리가 광범위 → attrs 전파를 건드리는 픽스의 **regression-trap**이 큼. `keep_attrs` 콜백을 제거하므로 다른 strategy 경로를 깨지 않는지 검증 필요.
- 공식 라벨 "15min-1hour"와 일치. localize는 쉬우나 케이스 분기 합성 + 회귀 안전이 시간을 먹는 전형적 T4.

## 골드패치 분석

- **파일·함수**: `xarray/core/computation.py`의 `where(cond, x, y, keep_attrs=None)`.
- **근본원인**: 수정 대상 base commit(3aa75c8)의 코드는 `keep_attrs is True`일 때 `keep_attrs = lambda attrs, context: getattr(x, "attrs", {})`를 `apply_ufunc`에 넘겼다. 이 회귀의 **단일 원인**은 이 상수 콜백이 출력의 *모든* 변수(데이터 변수와 좌표 포함)에 동일하게 `x.attrs`를 부여한다는 것 → `time` 같은 좌표의 attrs가 데이터 변수 attrs로 오염. (참고: hints의 `attrs[1]`/`_get_all_of_type` 인덱싱은 #6461 *이전*(pre-#6461)의 옛 구현으로, base 코드에는 존재하지 않으며 이번에 고쳐지는 좌표-덮어쓰기 버그의 메커니즘과는 무관하다. scalar일 때 `attrs[1]`이 `y` attrs를 집는 불안정성은 이 회귀의 원인 요소가 아니라, hints 방향으로 따라가면 만나는 별개의 함정이다 — §모범답안 (a) 참조.)
- **수정요지**: `lambda` 콜백을 제거하고 `apply_ufunc` 결과를 `result`로 받은 뒤, `keep_attrs is True`일 때 **결과 객체에서 직접 레벨별로 attrs 재구성**:
  - `y`가 Dataset이고 `x`가 아닌 승격 케이스: `result.attrs = {}`로 두고 `x.name`이 `result.data_vars`에 있으면 그 변수에만 `x.attrs` 복사.
  - 일반 케이스: `result.attrs = getattr(x, "attrs", {})` + 각 `result.data_vars` `v`에 대해 `getattr(x, v).attrs` 복사.
  - 항상: 각 `result.coords` `c`에 대해 `getattr(x, c).attrs` 복사 → 좌표 attrs는 언제나 `x`에서 보존.
  - `from .dataset import Dataset`를 함수 내부 지연 import로 추가(순환 import 회피).

## 검증 (test_patch)

- **FAIL_TO_PASS (1)**: `test_where_attrs`. 기존엔 `dims="x"`인 단순 DataArray 3개만 검사했으나, 패치 후엔 좌표 `a`에 별도 attrs를 부여하고 7개 시나리오로 확장: 3 DataArray(x attrs 채택), x scalar(attrs 없음), y scalar(x attrs), x·y scalar(없음), cond scalar, DataArray+2 Dataset, 2 DataArray+1 Dataset. 각 케이스에서 데이터 변수 attrs와 **좌표 `a`의 attrs(`x_coord`)**가 모두 올바른지 `assert_identical`로 검증.
- **픽스 증명**: 좌표 attrs를 `result.coords` 루프에서 항상 `x`로부터 복사하므로 `cond_coord`/`y_coord`로 덮이지 않고 `x_coord` 유지. scalar 케이스는 `getattr(x, "attrs", {})`가 `{}`를 돌려줘 attrs 없음. Dataset 승격은 전용 분기가 처리.
- **overfit 관점**: F2P가 1개이지만 그 안에 7개 입력 변형(scalar/Dataset 승격/coord)이 들어가 케이스 커버리지가 두터움 → special-case 통과 위험 낮음. overfit-risk 플래그 미부여.
- **regression 관점**: P2P 280개, 특히 `test_keep_attrs_strategies_dataset_variables[*-coord]` 등 coord 전파를 직접 검사하는 항목이 다수 → 콜백 제거가 `default`/`override`/`drop_conflicts` 등 다른 keep_attrs 경로를 깨지 않음을 보장해야 함(regression-trap).

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `xr.where(..., keep_attrs=True)` + PR #6461의 `lambda attrs, context: getattr(x, "attrs", {})`를 명시 → `xarray/core/computation.py::where`로 직행. MVCE(`...time.attrs`가 데이터 변수 attrs로 나옴)로 "좌표가 변수 attrs로 덮인다"는 증상을 확정.
2. **픽스와 일반화 근거**: 근본 결함은 콜백이 출력의 모든 변수에 무차별 `x.attrs`를 주입한다는 것. 올바른 일반화는 attrs를 **출력 레벨(global / data_vars / coords)별로 분리 복사**하는 것 — 좌표는 항상 `x`의 동명 좌표 attrs로, 데이터 변수는 `x`의 동명 변수 attrs로. 이는 docstring 계약("`x`의 attrs를 보존")을 레벨 단위로 정밀화한 것이라 단일 테스트가 아닌 attrs 전파 시맨틱 전체에 맞는 일반해.
3. **regression 안전**: `keep_attrs` 콜백을 통째로 제거하므로, `keep_attrs is None`(기본 False)·명시 콜백·strategy 문자열 경로는 그대로 `apply_ufunc`에 위임돼 불변. P2P의 `test_keep_attrs_strategies_*` 전부가 이 경로를 검증하므로 후처리 블록을 `keep_attrs is True` 분기 안에만 가둬야 안전(골드패치가 정확히 그렇게 함).
4. **함정 회피**: (a) hints의 `attrs[1]`/`_get_all_of_type` 방향으로 따라가면 scalar일 때 인덱스가 어긋나 `y` attrs를 집는 함정 → 인덱싱 대신 결과 객체에서 직접 attrs를 읽어야 함. (b) `result.attrs = x.attrs`만 하고 coords를 빠뜨리면 정확히 이 버그가 재발 → coords 루프 필수. (c) `x`가 DataArray인데 `y`가 Dataset인 승격 케이스를 무시하면 `result.data_vars` 매핑이 어긋남 → Dataset 전용 분기 필요. (d) `from .dataset import Dataset`를 모듈 최상단에 두면 순환 import → 함수 내부 지연 import로 처리.
