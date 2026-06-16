---
instance_id: pydata__xarray-3095
repo: pydata/xarray
base_commit: 1757dffac2fa493d7b9a074b84cf8c830a706688
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2019-07-11T13:16:16Z
fail_to_pass: 1
pass_to_pass: 253
gold_files: [xarray/core/indexing.py, xarray/core/variable.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
`Dataset.copy(deep=True)` 및 `DataArray.copy(deep=True)`가 dtype이 `<U*`(고정폭 유니코드)인 IndexVariable을 실수로 object dtype으로 캐스팅한다. `copy.copy()`/`copy.deepcopy()`도 동일. xarray 0.12.2에서 도입된 회귀로, hint에 원인 커밋(c04234d4)까지 명시되어 있다. 좌표 `x`가 `<U3`에서 `object`로 바뀌는 재현 세션이 이슈에 그대로 첨부되어 있다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 "copy(deep=True)"와 회귀 커밋을 지목한다. `Variable.copy` → `PandasIndexAdapter` 경로로 좁은 단일 흐름으로 수렴하나, 픽스가 `variable.py`와 `indexing.py` 두 파일에 걸쳐 조율돼야 해 grep 한 방(L0)은 아니다.
- **S (Strategy) = S2 (+S6)**: 고칠 지점은 명확하지만 "왜 object로 바뀌는가"는 dtype 보존 불변식을 추론해야 한다. 기존 코드는 `PandasIndexAdapter(self._data.array.copy(deep=True))`로 **dtype 인자 없이** 어댑터를 재생성 → `__init__`이 dtype을 재추론하며 `<U3`을 `np.dtype('O')`로 떨어뜨린다. 올바른 픽스는 단순 가드가 아니라 어댑터에 `copy()` 메서드를 도입(S6: lifecycle/책임 재배치)하고 호출부를 그쪽으로 위임하는 작은 구조 변경이다.
- **K (Knowledge) = K-Domain**: numpy dtype(`<U*` vs `object`) × pandas Index dtype 추론 × xarray IndexVariable 내부 자료구조를 알아야 근본원인이 보인다.
- **Primary = T-ConstraintReason**: 위치는 거의 주어졌으나, 핵심 난점이 "dtype 보존이라는 불변식을 어디서 깨고 어떻게 일반적으로 지킬지"를 추론 합성하는 데 있다. 이게 S2의 정의이며 primary를 결정한다.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일수 2 / 헌크 다수지만 의미 있는 로직 변경은 ~10줄(나머지는 타입힌트). 줄수 기준은 가볍다.
- localize는 has-repro + 회귀 커밋 지목으로 비교적 직접적(L1).
- 그러나 **regression-trap이 강함**: `PandasIndexAdapter.copy`가 `pickle` 시 shallow→deep 메모리 폭증(주석의 4MB vs 8MB 측정)을 피하도록 `deep` 분기를 정확히 보존해야 하고, P2P 253개(copy/copy_index/multiindex/pandas_period_index 등 인접 동작 전부)를 깨면 안 된다.
- cross-file-dep: `variable.py`가 `indexing.py`의 새 메서드에 의존.

공식 라벨 "15분~1시간"과 일치한다(상한). 다만 정답이 "dtype을 그냥 다시 넘기기"가 아니라 어댑터 책임 재설계라는 점, deep/shallow + pickle 미묘함이 끼어드는 점이 단순 T2/T3으로 떨어지지 않게 민다.

## 골드패치 분석
- **`xarray/core/indexing.py` — `PandasIndexAdapter`**:
  - `__init__`에 `else: dtype = np.dtype(dtype)` 추가 → 명시 dtype을 일관되게 정규화.
  - **신규 `copy(self, deep=True)` 메서드**: `array = self.array.copy(deep=True) if deep else self.array` 후 `PandasIndexAdapter(array, self._dtype)`로 **저장된 `_dtype`을 그대로 전달**해 dtype 보존. 주석으로 shallow numpy.ndarray가 pickle 시 deep으로 변해 메모리가 2배 되는 함정을 명시.
  - 나머지(`dtype`/`__array__`/`shape`/`__getitem__`/`transpose`/`__repr__`)는 타입힌트만 추가(동작 무변).
- **`xarray/core/variable.py` — `IndexVariable.copy`** (서브클래스 `class IndexVariable(Variable)` 내부, base `Variable.copy`와 별개 메서드 — base는 `PandasIndexAdapter` 분기 자체가 없어 패치 무관): `data is None`일 때 deep/shallow를 직접 분기해 `PandasIndexAdapter(self._data.array.copy(deep=True))`로 재생성하던 코드를 **`data = self._data.copy(deep=deep)`** 한 줄로 위임. 버그·픽스 모두 `IndexVariable` 전용이다(FAIL_TO_PASS = `TestIndexVariable::test_copy[str-True]`).
- **근본원인**: 기존 호출부가 어댑터를 dtype 없이 재구성 → `__init__`의 dtype 재추론이 `<U*`을 `'O'`로 강등. 책임이 호출부에 흩어져 dtype 컨텍스트(`_dtype`)가 유실됐다.
- **수정요지**: dtype을 아는 어댑터 자신에게 복제 책임을 옮겨 `_dtype`을 항상 동반 전달 → dtype 보존 불변식을 한 곳에서 강제.

## 검증 (test_patch)
- `test_copy`를 `@pytest.mark.parametrize('astype', [float, int, str])`로 확장. FAIL_TO_PASS는 **`TestIndexVariable::test_copy[str-True]`** 하나 — 즉 IndexVariable + 문자열 dtype + deep=True에서만 회귀가 드러난다.
- 픽스 증명: `v = IndexVariable('x', np.array(['...']).astype(str))`, `w = v.copy(deep=True)` 후 `assert_identical(v, w)`. `assert_identical`은 dtype까지 비교하므로 `<U*`→object 강등이 곧바로 실패로 잡힌다. 픽스 후 `_dtype` 보존으로 통과.
- overfit 관점: F2P=1로 얇아 보이나, `astype × deep` 곱과 `TestVariable/TestVariableWithDask/TestIndexVariable` 3클래스가 P2P에 모두 들어 있어(`test_copy[str-True]` 자체도 비-IndexVariable 클래스에서는 P2P) 사실상 격자 전체가 검증된다. special-case로 통과시키기 어렵다.
- regression 관점: `test_copy_index`, `test_multiindex`, `test_pandas_period_index`, `test_concat_*` 등이 P2P에 있어 deep/shallow 분기·MultiIndex·PeriodIndex 경로를 깨면 즉시 적발된다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "copy(deep=True)" + 회귀 커밋 c04234d4 → `IndexVariable.copy`(`variable.py`의 서브클래스 `IndexVariable`, base `Variable.copy`가 아님)의 `data is None and deep` 분기로 직행. 거기서 `PandasIndexAdapter(self._data.array.copy(deep=True))`가 dtype 인자를 누락함을 관찰하고, `indexing.py`의 `PandasIndexAdapter.__init__` dtype 재추론(`PeriodIndex`/datetime/`object` 분기)이 `<U*`을 `'O'`로 떨어뜨림을 연결한다.
2. **픽스**: dtype을 호출부에서 재전달할 수도 있으나, 올바른 일반화는 어댑터에 `copy(deep)`를 두고 `self._dtype`을 항상 동반시키는 것. 이는 IndexVariable의 모든 복제 경로(향후 추가 호출부 포함)에서 dtype 보존을 한 지점에 봉인하므로 회귀 재발을 구조적으로 막는다.
3. **regression 안전**: deep=False일 때 `self.array`를 그대로 반환해 얕은 복제 의미를 유지해야 한다(P2P의 `test_copy[*-False]`). MultiIndex/PeriodIndex 경로(`test_multiindex`, `test_pandas_period_index`)와 pickle 메모리 특성(주석의 측정)을 깨지 않도록 `deep` 분기를 정확히 보존한다.
4. **함정 회피**: (a) `Variable.copy`에서 dtype만 다시 넘기는 국소 패치는 동작하지만 책임이 흩어진 채 남아 다음 호출부에서 재회귀 위험 — 어댑터 위임이 정답. (b) `deep` 의미를 무시하고 항상 deep copy하면 shallow 케이스의 의도(공유)와 pickle 메모리 보장이 깨진다. (c) `__init__`에서 명시 dtype을 `np.dtype()`로 정규화하지 않으면 `_dtype` 비교(`assert_identical`)가 미묘하게 어긋날 수 있다 — 골드가 `else: dtype = np.dtype(dtype)`를 추가한 이유.
