---
instance_id: astropy__astropy-14995
repo: astropy/astropy
base_commit: b16c7d12ccbc7b2d20364b89fb44285bcbfede54
version: "5.2"
difficulty: "<15 min fix"
created_at: 2023-06-27T19:48:18Z
fail_to_pass: 1
pass_to_pass: 179
gold_files: [astropy/nddata/mixins/ndarithmetic.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
astropy v5.3에서 `NDDataRef` 산술연산 시 한쪽 operand에 mask가 없으면(`mask is None`) mask 전파가 깨진다. 특히 `handle_mask=np.bitwise_or`로 곱셈할 때 `TypeError: unsupported operand type(s) for |: 'int' and 'NoneType'`가 발생한다. v5.2에서는 한쪽 mask가 None이면 다른 쪽 mask를 그대로 복사해 출력했는데, v5.3 리팩토링에서 그 분기 조건이 바뀌면서 None mask를 `handle_mask`로 넘겨버린다. 곱셈은 교환법칙이 성립해야 하는데 `nd1.multiply(nd2)`와 `nd2.multiply(nd1)`의 결과가 달라지는 비대칭도 함께 드러난다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문과 hints에서 `_arithmetic_mask`의 `elif operand.mask is None` → `elif operand is None` 회귀를 직접 지목하고, culprit 라인과 도입 커밋까지 명시됨. grep 한 방.
- **S2 (Constraint-Reasoning)**: 위치는 자명하나 올바른 조건식을 불변식으로 추론해야 한다. "self는 mask 있고 operand는 mask 없음" 케이스에서 `self.mask`를 복사해야 한다는 분기 조건(`operand.mask is None`)을 정확히 합성하는 게 본질. 후보를 마구 시도하는 G&V가 아니라 None-전파 불변식 추론.
- **K-Domain (Domain-bound)**: NDData mask 시맨틱(truthy bitmask vs boolean), `handle_mask` 콜백 계약, v5.2 동작 보존 의도를 이해해야 올바른 조건을 고른다. 일반 파이썬 추론만으론 "왜 None을 handle_mask에 넘기면 안 되는지" 정당화가 약하다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하지만 픽스가 상수/가드 추가가 아니라 잘못된 술어(`operand` truthiness)를 올바른 술어(`operand.mask is None`)로 교체하는 조건 합성이라 DirectMap보다 ConstraintReason. S2를 택한 이유: 결함은 None-guard 누락이 아니라 분기 술어 오류이며, 정답은 "어떤 불변식이 보존돼야 하는가"(mask 없는 operand는 상대 mask를 그대로 통과)에서 도출된다.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일 1개(`ndarithmetic.py`), 실질 변경 1줄(주석 오타 1줄은 무관) → scope 최소(<5줄 ≈ 48% solve 구간).
- localize 직접성 극상(L0): 이슈에 culprit 라인이 적혀 있음.
- `has-repro`: 네이티브 `TypeError`와 재현 스니펫 존재 → 가장 강한 easiness 신호.
- 그러나 단순 가드 추가가 아니라 분기 술어 의미를 추론해야 하고(S2), `regression-trap`이 강하다: PASS_TO_PASS 176개 중 `test_arithmetics_data_masks[...]` 다수가 None/True/False mask 조합을 검증해 잘못 고치면 인접 케이스가 깨진다.
공식 라벨은 `<15 min fix`(T1~T2급)지만, 개발자 구현시간 기준일 뿐이다. 에이전트 관점에선 (a) 술어 의미 추론과 (b) 넓은 P2P trap 때문에 T2가 아닌 T3로 조정. has-repro + 1줄이 아래로, regression-trap + S2/K-Domain이 위로 밀어 중간으로 수렴.

## 골드패치 분석
- **파일·함수**: `astropy/nddata/mixins/ndarithmetic.py`의 `_arithmetic_mask(self, operation, operand, handle_mask, axis=None, **kwds)` (약 520라인).
- **근본원인**: v5.3 propagation 리팩토링(PR #14175, 커밋 feeb716b)에서 분기 조건이 `elif operand.mask is None:`에서 `elif operand is None:`으로 잘못 바뀐 회귀. operand 객체 자체는 거의 항상 None이 아니므로(연산 상대가 존재) 이 분기는 사실상 죽고, mask가 없는 operand는 곧장 마지막 `else`의 `handle_mask(self.mask, operand.mask, **kwds)`로 흘러간다. 거기서 `operand.mask`가 `None`이라 `np.bitwise_or(int, None)`이 `TypeError`를 던진다. boolean mask여도 `None`이 dtype=object 배열로 섞이는 오염이 발생.
- **수정요지**: 분기 술어를 `operand.mask is None`으로 되돌려, self는 mask가 있고 operand는 mask가 없는 경우 `deepcopy(self.mask)`로 self의 mask를 그대로 전파. 이로써 v5.2 동작(한쪽 None이면 상대 mask 통과)과 곱셈 교환법칙이 복원된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_nddata_bitmask_arithmetic`. 정수 bitmask로 다섯 케이스를 검증: nomask×constant, nomask×nomask(둘 다 `mask is None`), masked×constant, masked×masked(동일 mask 유지), masked×nomask(=culprit, `self.mask` 통과). 마지막으로 서로 다른 bitmask 둘을 `bitwise_or`해 비트 논리가 살아있음을 확인.
- **픽스 증명**: `masked.multiply(nomask, handle_mask=np.bitwise_or).mask == mask`가 픽스 전엔 `TypeError`였다가 픽스 후 `self.mask` 복사로 통과. `nomask.multiply(...)`가 여전히 `None`을 반환하는지도 검증해 self-mask-None 분기(`return deepcopy(operand.mask)`)와의 대칭 보존.
- **overfit 관점**: FAIL_TO_PASS 1개로 얇아 보이나, 테스트가 nomask/masked × constant/self/other의 5조합 + bitwise 결합까지 망라해 special-case 통과를 막는다. 픽스가 1줄 술어 교체라 overfit 여지 자체가 작음(`overfit-risk` 미부여).
- **regression 관점**: PASS_TO_PASS 176개가 핵심 안전망. 특히 `test_arithmetics_data_masks`의 None/True/False/배열 mask 조합이 두 None-분기(`self.mask is None`, `operand.mask is None`)와 `else` 경로를 모두 커버하므로, 술어를 잘못 고치면 즉시 RED.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `TypeError: ... '|': 'int' and 'NoneType'` 스택과 hints의 "`elif operand.mask is None` → `elif operand is None`로 바뀐 것 같다"는 단서를 따라 `ndarithmetic.py::_arithmetic_mask`의 mask 분기 사다리로 직행. v5.2↔v5.3 diff 또는 명시된 커밋 feeb716b을 보면 회귀 라인이 즉시 드러난다.
2. **픽스와 일반화 정당성**: `elif operand is None:`을 `elif operand.mask is None:`으로 교체. 이는 special-case 패치가 아니라 분기의 본래 불변식 복원이다 — "두 mask 중 하나가 None이면 출력은 나머지 mask"라는 대칭 규칙. 위쪽에 이미 `self.mask is None and operand is not None → deepcopy(operand.mask)` 분기가 있으므로, 짝이 되는 `operand.mask is None → deepcopy(self.mask)`를 복원하면 교환법칙과 v5.2 시맨틱이 동시에 성립. `else`의 `handle_mask`에는 양쪽 모두 non-None mask일 때만 도달하게 되어 None 오염이 구조적으로 차단된다.
3. **regression 안전**: `test_arithmetics_data_masks`의 None/True/False/array 조합(P2P)을 깨지 않아야 한다. 술어를 `operand.mask is not None` 같은 반대로 쓰거나 `else`에 None-가드만 덧대는 대안은 self-mask-None 분기와의 대칭을 깨 이들 케이스가 RED. 정답은 분기 추가가 아니라 잘못된 술어 1개 교정이라 인접 동작을 건드리지 않는다.
4. **함정 회피**: (a) `operand`(객체)와 `operand.mask`(속성)의 혼동 — 오라클 없는 에이전트가 "operand가 None일 수 있다"는 표면 추론에 빠져 `else`에 `if operand.mask is None` 가드를 덧붙이면 중복·비대칭 코드가 됨. 정공법은 죽은 분기 술어 자체를 고치는 것. (b) "mask는 boolean 가정"이라는 docstring에 현혹돼 bitmask 케이스를 invalid로 처리하려는 오판 — 도메인상 mask는 truthy(0=unmasked) 비트마스크가 합법이므로 동작 변경이 아니라 회귀 복원이 정답. (c) 주석 오타(`lets`→`let's`)는 기능과 무관하니 본질에 집중.
