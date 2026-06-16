---
instance_id: matplotlib__matplotlib-22719
repo: matplotlib/matplotlib
base_commit: a2a1b0a11b993fe5f8fab64b6161e99243a6393c
version: "3.5"
difficulty: "<15 min fix"
created_at: 2022-03-28T14:42:28Z
fail_to_pass: 1
pass_to_pass: 68
gold_files: [lib/matplotlib/category.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
문자열(카테고리) 단위 변환기가 붙은 축에 빈 데이터(`[]`)를 넘기면 혼란스러운 `MatplotlibDeprecationWarning`("Support for passing numbers through unit converters is deprecated")이 발생한다. 재현은 `ax.xaxis.update_units(["a","b"])` 후 `ax.plot([], [])` 한 줄. 빈 배열은 `all(...)`이 vacuously True가 되어 "전부 numlike"로 판정되고, 경고가 발화 후 `ConversionError`로 이어진다. 기대 동작은 빈 데이터에 대해 경고 없이 통과하는 것.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈 본문에 네이티브 traceback이 그대로 박혀 있어 `category.py`의 `convert` → `if is_numlike:` 라인(62번 근처)을 직접 가리킨다. 다만 두 번째 사이트(`UnitData.update`의 `if convertible:`)는 traceback에 안 보여서 코드 읽기로 추가 발견해야 함 → grep 한 방은 아니므로 L0이 아니라 L1.
- **S (Repair Strategy) = S1 (+S2)**: 정형 결함클래스 — "빈 컬렉션에 `all()` vacuous-truth 가드 누락". 픽스가 사실상 `if X:` → `if data.size and X:`로 기계적 가드 추가. 다만 *왜* `.size`인지(values가 numpy array라 truthiness가 ambiguous), 그리고 *어느 두 사이트* 모두여야 하는지를 따져야 해 S2 보조.
- **K (Knowledge) = K-Domain**: matplotlib 단위 변환기(ConversionInterface) 내부 동작·numpy array 의미를 알아야 픽스가 안전함을 확신할 수 있음.
- **primary = T-DirectMap**: 위치는 traceback으로 명확하고 픽스는 None/empty 가드 추가라는 기계적 매핑. 이슈가 "empty data edge case를 못 잡은 것"이라고 사실상 진단까지 적어줌.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일(`category.py`)·2헌크·실질 변경 2줄, `has-repro`(네이티브 traceback + 최소 재현 코드 + hint에 patch까지 첨부). localize 직접성 높음. 한 가지 마찰은 traceback에 안 나오는 두 번째 사이트(`UnitData.update`)를 빠뜨리면 부분 픽스가 된다는 점과, P2P 68개라는 넓은 regression 면(`regression-trap`)이다 — `.size` 가드가 비빈 데이터의 기존 deprecation 경고/로그 발화를 깨면 안 됨. 공식 라벨 `<15 min fix`와 일치(T1까진 아닌 이유: 단일 사이트 자명 픽스가 아니라 두 사이트 조율 + 넓은 P2P를 안 깨야 함).

## 골드패치 분석
- **파일/함수**: `lib/matplotlib/category.py` 두 곳.
  - `StrCategoryConverter.convert(value, unit, axis)`: `if is_numlike:` → `if values.size and is_numlike:`
  - `UnitData.update(self, data)`: `if convertible:` → `if data.size and convertible:`
- **근본원인**: 두 사이트 모두 `is_numlike`/`convertible`을 `all(... for v in values)` 형태로 계산. 빈 시퀀스에서 `all()`은 **vacuously True**를 반환하므로, 빈 데이터가 "전부 숫자형"으로 오판되어 deprecation 경고(`convert`)와 정보 로그(`update`)가 부적절하게 발화된다.
- **수정요지**: 발화 조건 앞에 `values.size`/`data.size` (numpy array 비어있지 않음) 가드를 AND로 추가. 빈 입력이면 가드가 short-circuit으로 False → 경고·로그 자체가 안 일어나고, 그 결과 후속 `ConversionError`까지 사라진다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `test_no_deprecation_on_empty_data` — `ax.xaxis.update_units(["a","b"])` 후 `ax.plot([], [])`를 실행하는 smoke test. 테스트 모듈은 deprecation 경고를 error로 승격하므로(matplotlib 테스트 관례) 경고 발화 시 곧장 실패. 픽스로 `values.size`가 0 → 경고 미발화 → 통과.
- **픽스 증명**: 가드가 정확히 "빈 데이터"라는 발화 조건만 차단하므로 테스트의 그린이 픽스 인과와 직결.
- **overfit/regression**: overfit 위험 낮음 — 픽스가 빈 시퀀스 vacuous-truth라는 일반 결함을 직접 막고, 비빈 데이터 경로는 `.size`가 truthy라 무영향. 단 P2P 68개(`TestUnitData`, `TestStrCategoryConverter`, `TestPlotTypes` 등)가 비빈 경로의 기존 경고·로그·변환 동작을 보증 → regression 면이 넓지만 가드의 short-circuit 특성상 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 native traceback이 `category.py:62`의 `if is_numlike:` → `_api.warn_deprecated`를 직접 지목. 여기가 1차 사이트. 추가로 같은 파일에서 동일 vacuous-truth 패턴(`if convertible:` in `UnitData.update`)을 코드 읽기로 찾아 2차 사이트 확보.
2. **픽스와 일반화**: 두 발화 가드 모두에 `values.size`/`data.size`를 AND로 선행. `len(values)`나 `if values:`가 아니라 `.size`인 이유 — `values`가 numpy array이고 array의 boolean truthiness는 원소>1이면 ambiguous error를 던지기 때문. 빈/비빈 두 경우만 갈라야 하므로 `.size`가 올바른 일반화이고 special-case 하드코딩이 아님.
3. **regression 안전**: P2P의 비빈 입력 테스트(`test_convert*`, `test_plot_*`, `TestUnitData::test_update` 등)가 기존 경고·로그·매핑 동작을 보증. `.size`가 truthy인 경로는 분기 결과가 이전과 동일해 안 깨짐.
4. **함정 회피**: (a) traceback의 1차 사이트만 고치면 `UnitData.update` 로그가 빈 데이터에 여전히 발화 → 부분 픽스. 같은 파일 동일 패턴을 반드시 동반 수정. (b) `if values:`로 잘못 쓰면 비빈 array에서 truth-value ambiguous 예외. `.size` 필수. (c) 경고 발화 자체를 막지 않고 `convert` 상위에서 예외만 삼키려 하면(broad except) 이슈가 지적한 "너무 넓게 잡는다"는 원인을 그대로 재현 — 발화 조건을 정밀화하는 것이 정답.
