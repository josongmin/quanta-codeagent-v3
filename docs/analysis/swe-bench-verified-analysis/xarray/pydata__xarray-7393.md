---
instance_id: pydata__xarray-7393
repo: pydata/xarray
base_commit: 41fef6f1352be994cd90056d47440fe9aa4c068f
version: "2022.09"
difficulty: "15 min - 1 hour"
created_at: 2022-12-20T04:34:24Z
fail_to_pass: 2
pass_to_pass: 71
gold_files: [xarray/core/indexing.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`Dataset.stack()`로 MultiIndex를 만들면 int32(`i4`) 좌표가 int64(`i8`)로 캐스팅된다. 사용자는 MVCE에서 `ds['a'].values.dtype == ds.stack(b=('a',))['a'].values.dtype`가 `False`가 되는 것을 보고했다. 근본은 pandas MultiIndex의 level 값을 `.values`로 꺼낼 때 pandas가 dtype을 승격(promote)시키는 것이지만, xarray 래퍼는 원본 dtype을 이미 추적하고 있으므로 numpy 변환 시 이를 복원할 수 있다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈 댓글(benbovy)이 `xarray/core/indexing.py` L1528-L1532를 직접 지목하고, 정확한 메서드(`PandasMultiIndexingAdapter.__array__`)와 거의 완성된 픽스 스니펫까지 첨부했다. grep 불필요, 핀포인트.
- **S1 (Direct-Map) + 보조 S2**: 픽스가 사실상 이슈에 명세되어 있다(기계적 dtype-coercion 패턴: `dtype is None → self.dtype` 기본값 + `np.asarray(..., dtype=dtype)` 강제). "타입 강제" 결함클래스 템플릿에 정확히 매칭. 다만 *왜* `self.dtype`가 올바른 복원원천인지(래퍼가 원본 dtype을 보존한다는 불변식)를 이해해야 하므로 약한 S2가 섞인다.
- **K-Domain**: pandas Index가 Int64Index로만 승격된다는 사실, xarray adapter가 `_dtype`를 별도 보존한다는 내부 구조를 알아야 "복원" 발상이 나온다. 일반 파이썬 추론으로는 부족.
- **primary = T-DirectMap**: 위치가 명확하고 픽스가 기계적 dtype 강제이므로. APR 관점에서 PAR/TBar식 "타입 캐스트 삽입" 변환 템플릿으로 바로 합성 가능 — 후보 다수를 테스트로 거르는 G&V가 아니라 단일 결정론적 픽스다.

## 난이도 티어
**T2 (쉬움).** 구조적 피처: 1파일·1함수·+4/-1줄(헌크 1개), localize 직접성 최상(이슈가 줄번호+픽스 제공 → has-repro 동급의 easiness 신호), MVCE 재현 명확. P2P 73개로 regression-trap이 형식상 존재하나, 픽스가 `dtype=None` 경로에서 `super().__array__(dtype)`와 동치를 유지하도록 짜여 인접 동작을 깨지 않는다(아래 검증 참조). 도메인 지식이 필요해 T1은 아니지만, 추론 부담이 가벼워 T3까지 가지 않는다. 공식 라벨 "15분-1시간"과 정합 — 개발자 구현시간 기준이며, 에이전트 난이도도 동일하게 낮다(이슈가 픽스를 거의 적어줌).

## 골드패치 분석
- **파일·함수**: `xarray/core/indexing.py`의 `PandasMultiIndexingAdapter.__array__` (`PandasIndexingAdapter` 서브클래스, `__slots__ = ("array", "_dtype", "level", "adapter")`).
- **근본원인**: `self.level is not None`일 때 `self.array.get_level_values(self.level).values`를 그대로 반환했다. pandas `get_level_values(...).values`는 정수 level을 int64로 승격시키므로, 래퍼가 보존 중인 원본 dtype(`self.dtype` 프로퍼티, `_dtype`에서 파생)이 무시되고 버려졌다.
- **수정요지**: (1) `dtype is None`이면 `dtype = self.dtype`로 원본 보존 dtype을 기본값으로 채운다. (2) level 경로에서 `np.asarray(self.array.get_level_values(self.level).values, dtype=dtype)`로 명시 캐스트하여 원본 dtype을 복원한다. else 경로(`super().__array__(dtype)`)는 불변.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_restore_dtype_on_multiindexes[int32]`, `[float32]`. `Dataset(coords={"bar": ("bar", np.array([0,1], dtype=dtype))})`를 `stack(baz=("bar",))`로 MultiIndex화한 뒤 `str(foo["bar"].values.dtype) == dtype`를 단언. int32와 float32 두 dtype을 parametrize해, 정수 승격(int64)만이 아니라 임의 dtype 복원이라는 일반 동작을 검증한다 — special-case(int32만) overfit을 차단.
- **픽스 증명**: 패치 전엔 level 경로가 dtype을 강제하지 않아 int32→int64, float32→float64로 승격되어 단언 실패. 패치 후 `self.dtype`가 원본을 보존하고 `np.asarray(..., dtype=dtype)`가 복원하므로 통과.
- **overfit/regression**: float32까지 parametrize한 점에서 overfit 위험은 낮다. `dtype=None` 기본값을 `self.dtype`로 채우는 변경이 핵심 regression 포인트지만, 비-MultiIndex 경로(`super().__array__`)와 명시 dtype 호출은 영향받지 않는다. P2P 73개(TestPandasMultiIndex의 stack/unstack/sel/concat 등)가 모두 통과해 인접 인덱싱 동작 보존이 입증된다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 본문이 `stack`이 dtype을 바꾼다고 명시하고, 댓글이 `indexing.py` L1528-L1532를 직접 지목. `stack` → MultiIndex level 값 추출 → `.values` 승격이라는 데이터플로우를 따라 `PandasMultiIndexingAdapter.__array__`에 도달한다(댓글 없이도 "values.dtype vs .dtype 불일치" 힌트로 adapter의 dtype 보존 로직을 추적 가능).
2. **픽스**: `self.array.get_level_values(level).values`의 승격 결과를 래퍼가 이미 보존 중인 `self.dtype`로 `np.asarray` 캐스트. 이게 올바른 일반화인 이유 — 하드코딩 int32가 아니라 *래퍼가 추적하는 원본 dtype 불변식*을 복원하므로 모든 dtype(int/float/...)에 일반적으로 작동. `dtype is None` 가드는 명시 dtype 호출과의 하위호환을 보존한다.
3. **regression 안전**: `dtype is None`일 때만 `self.dtype`를 주입하고 else 경로는 `super().__array__(dtype)`로 그대로 위임 → 비-level 변환과 명시 dtype 변환은 byte-identical. TestPandasMultiIndex의 stack/unstack/concat/sel 등 P2P를 깨지 않음을 이로써 보장.
4. **함정 회피**: (a) "pandas 버그라 못 고친다"는 초기 hint에 멈추지 말 것 — 래퍼가 원본 dtype을 보존하므로 xarray 측 복원이 가능하다. (b) int 승격만 보고 `astype(int32)` 식으로 정수에 특수화하면 float32 테스트에서 실패 → 반드시 `self.dtype` 일반 복원으로 가야 한다. (c) `dtype is None` 기본값 처리를 빠뜨리면 명시 dtype 경로나 numpy의 `__array__(dtype=...)` 계약이 어긋나 latent regression이 생긴다.
