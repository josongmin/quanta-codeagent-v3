---
instance_id: astropy__astropy-13236
repo: astropy/astropy
base_commit: 6ed769d58d89380ebaa1ef52b300691eefda8928
version: "5.0"
difficulty: "15 min - 1 hour"
created_at: "2022-05-09T14:16:30Z"
fail_to_pass: 2
pass_to_pass: 644
gold_files: [astropy/table/table.py]
primary_type: T-SpecInference
tier: T3
loc_axis: L0
repair_strategy: S5 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
구조화된(structured) `np.ndarray`를 `Table`에 넣으면 자동으로 `NdarrayMixin`으로 view 변환된다. 이 자동변환의 원래 이유는 structured dtype `Column`이 (특히 직렬화에서) 제대로 동작하지 않아서였는데, #12644로 structured `Column`이 완전 지원되면서 더 이상 필요·바람직하지 않다. 이슈는 해당 변환 절을 제거(또는 FutureWarning 후 제거)하여 structured 배열을 그냥 `Column`으로 추가하자고 제안하며, 메인테이너 논의 끝에 "그냥 지금 줄 몇 개 지우고 테스트 추가"로 합의된다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문이 고쳐야 할 코드 블록을 verbatim으로 붙여놓았다 — `data = data.view(NdarrayMixin)`을 하는 `len(data.dtype) > 1` 절. `_convert_data_to_col` 한 함수, grep 한 방.
- **S5 Spec-Inference (+S1)**: 어디를 지울지는 자명하지만, "지워도 되는가"의 핵심은 코드가 아니라 **스펙 재구성**에 있다. NdarrayMixin의 존재 이유(직렬화 한계)가 #12644 이후 무효화됐다는 도메인 계약을 이슈/관례에서 읽어내야 "삭제가 올바른 동작"임을 확정할 수 있다. 일단 그 스펙을 받아들이면 실제 변경은 절 삭제(S1, 기계적)다.
- **K-Domain**: `NdarrayMixin` vs structured `Column`/`MaskedColumn`, mixin 디스패치(`data_is_mixin`), unified I/O 직렬화 경계 등 astropy table 내부지식이 판단을 지배한다.
- primary = **T-SpecInference**: 진짜 난점이 "코드 찾기"도 "식 합성"도 아니라 *이 자동변환이 더 이상 유효한 스펙이 아님을 입증*하는 데 있다. 그래서 repair strategy는 테스트 반복(S3/S4)이 아니라 의도 재구성(S5)이다.

## 난이도 티어
**T3 (중간).** 구조적 피처: 1파일·실질 **−7줄**(순삭제), localize는 L0로 거의 공짜, has-repro(이슈가 결함 블록·기대 동작을 직접 명시). 이것만 보면 T2이지만 두 가지가 T3로 민다: (1) **regression-trap** — P2P 644개가 table 핵심 경로(add_column/setitem/join/hstack/I-O write/mixin 전체)를 덮어, mixin 디스패치 한 줄을 잘못 지우면 광범위 회귀. (2) **스펙 판단 위험** — 오라클 없이 보면 "이 자동변환이 정상 기능인가 버그인가"가 모호해 보여, FutureWarning만 추가하고 동작을 안 바꾸면 FAIL_TO_PASS를 못 넘는다. 공식 라벨 "15min–1h"와 정합(개발자에겐 줄 삭제지만, 에이전트에겐 삭제의 정당성 판단이 비용).

## 골드패치 분석
- **파일·함수**: `astropy/table/table.py` 의 `Table._convert_data_to_col`.
- **근본원인**: 해당 메서드에 structured ndarray(`isinstance(data, np.ndarray) and len(data.dtype) > 1`)를 `data.view(NdarrayMixin)`으로 강제 변환하고 `data_is_mixin = True`로 마킹하는 절이 남아 있다. #12644 이후 structured dtype은 `Column`/`MaskedColumn`이 완전 지원하므로, 이 절은 불필요하게 사용자 데이터를 mixin으로 바꿔 I/O·repr·masking을 제약한다.
- **수정요지**: 그 6줄 절(주석 2줄 + if 4줄)을 통째로 삭제. 이후 structured 배열은 다운스트림의 일반 Column 경로를 그대로 타서 `Column`(마스킹 시 `MaskedColumn`)으로 추가된다. 행위 추가가 아니라 잘못된 분기 제거다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**:
  - `test_ndarray_mixin[False]` — 기존 `test_ndarray_mixin`을 `as_ndarray_mixin` True/False로 파라미터화. `False` 케이스는 plain structured 배열을 넣고 `class_exp = Column`을 기대 — 즉 자동 mixin 변환이 사라졌는지 검증. `[True]`(명시적 `.view(NdarrayMixin)`)는 여전히 mixin이어야 하므로 P2P로 남아 후방호환을 잠근다.
  - `test_structured_masked_column` — masked structured ndarray(`np.ma.array(..., dtype=structured)`)를 넣어 `t['a']`가 `MaskedColumn`이고 per-field `.mask`가 보존됨을 검증. 이전엔 NdarrayMixin view가 마스크를 죽였으므로 회귀 가드.
- **픽스 증명**: 절을 지워야만 `data_is_mixin`이 False로 남아 Column/MaskedColumn 경로로 흐르고, 두 단언이 통과한다. 절이 있으면 두 케이스 모두 `NdarrayMixin`이 되어 실패.
- **overfit·regression 관점**: overfit-risk 낮음 — 픽스가 코드 추가가 아닌 삭제라 special-case로 통과시킬 여지가 없다. `[True]` 케이스 유지 + 644 P2P(특히 mixin write/join/hstack)가 "mixin 메커니즘 자체를 깨지 않았는가"를 강하게 가둔다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 결함 코드블록과 변수명(`NdarrayMixin`, `data.view`, `len(data.dtype) > 1`)을 그대로 인용 → `astropy/table/table.py`에서 grep, `_convert_data_to_col` 내부 절로 즉시 수렴(L0).
2. **픽스와 일반화**: FutureWarning만 추가하는 보수적 절충에 멈추지 말고 — 메인테이너 합의(hints)가 "지금 바로 삭제"임을 읽어 — 그 절을 통째로 제거. structured Column이 #12644로 완전 지원되므로 mixin 우회는 잉여이고, 삭제는 "structured ndarray → 일반 Column 경로"라는 단일·일관 동작으로 일반화된다(특정 입력만 통과시키는 패치가 아님).
3. **regression 안전**: `[True]`(명시적 NdarrayMixin) 경로와 다른 mixin(Time/SkyCoord/Quantity 등) 디스패치는 건드리지 않는다 — 644 P2P 중 mixin write/join/hstack/add_column이 이를 감시. 삭제 대상이 오직 *암묵적 structured-ndarray 자동변환*임을 좁혀야 한다.
4. **함정 회피**: (a) "자동변환이 의도된 기능"으로 오판해 동작을 안 바꾸면 FAIL_TO_PASS 미통과 — 이슈의 "after #12644" 맥락이 스펙 무효화 신호다. (b) FutureWarning만 추가하는 절반 픽스는 `class_exp == Column` 단언을 못 넘는다. (c) masked 경로를 놓치면 `test_structured_masked_column`의 per-field mask 보존이 깨진다 — 삭제가 MaskedColumn 경로까지 자연히 살린다는 점을 이해해야 한다.
