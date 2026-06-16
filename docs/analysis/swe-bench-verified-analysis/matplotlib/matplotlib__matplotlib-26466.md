---
instance_id: matplotlib__matplotlib-26466
repo: matplotlib/matplotlib
base_commit: 3dd06a46750d174f821df5377996f493f1af4ebb
version: "3.7"
difficulty: "15 min - 1 hour"
created_at: 2023-08-07T19:30:22Z
fail_to_pass: 1
pass_to_pass: 100
gold_files: [lib/matplotlib/text.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`ax.annotate`에 numpy 배열을 `xy` kwarg로 넘긴 뒤, 호출 후 그 배열을 in-place로 수정하면 이미 그려진 annotation(특히 화살표) 위치가 함께 바뀐다. 원인은 배열의 복사본이 아니라 동일 객체 참조를 보관하기 때문이다(mutable aliasing). 이슈 본문은 `_AnnotationBase.__init__`을 1순위 의심처로 지목하고, `OffsetFrom` helper에도 같은 버그가 숨어 있을 수 있다고 명시한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `annotate` → `_AnnotationBase` 경로를 직접 가리키고 GitHub 라인까지 링크한다. 그러나 정확한 픽스 지점은 `self.xy = xy` 한 줄 + 두 번째 동족 사이트(`OffsetFrom.__init__`의 `self._ref_coord`)로, 후자는 본문이 "확인하겠다"고만 해 약간의 추가 탐색이 필요. L0은 아니다.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 알지만 "복사를 어떻게 하느냐"가 핵심. 골드는 `np.array(xy)` 대신 `x, y = xy`(언패킹) 후 `self.xy = x, y`를 택했다 — 복사(새 튜플 생성)와 **shape 검증(2-튜플 강제)**을 동시에 만족하는 불변식 합성이다. 단순 가드 추가(S1)가 아니라 "어떤 복사 표현이 입력 타입 전반을 옳게 일반화하는가"를 따져야 한다.
- **K-Domain (Domain-bound)**: matplotlib의 transform 파이프라인(`OffsetFrom.__call__`, `Affine2D().scale().translate()`)과 annotation 좌표 보관 관례를 알아야 두 사이트가 동치임을 안다. 일반 파이썬 추론만으론 `OffsetFrom`까지 못 본다.
- **primary = T-ConstraintReason**: 위치는 비교적 명확하나 픽스가 기계적 None-가드가 아니라 "복사 + shape 체크"라는 의미적 조건 합성이라 S2가 dominant.

왜 S2인가(APR 관점): 결함클래스는 정형(mutable-default/aliasing)이지만 픽스 후보가 `xy.copy()`, `np.array(xy)`, `tuple(xy)`, 언패킹 등 여러 갈래이고 각각 입력공간 커버리지가 다르다. 옳은 선택은 불변식("2D 좌표")을 코드로 강제하는 SemFix류 조건 합성이다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 단일 파일(`text.py`), 순 변경 ~10줄, has-repro(명확한 재현 스크립트+기대결과 이미지)로 재현은 쉬움. 그러나 (1) 픽스 사이트가 1곳이 아니라 2곳(`_AnnotationBase`와 `OffsetFrom` 둘 다 고쳐야 FAIL_TO_PASS 통과)이고, (2) 픽스 표현이 자명하지 않으며(단순 copy가 아니라 unpack), (3) PASS_TO_PASS 98개가 text/annotation 전반을 덮어 좌표 보관 변경이 인접 동작을 깰 수 있는 regression-trap이 있다. has-repro가 T2로 당기지만, 동족 사이트 누락 위험과 P2P 폭이 T3로 민다. 공식 라벨 "15분-1시간"과 일치.

## 골드패치 분석
- **건드린 파일/함수**: `lib/matplotlib/text.py` — `OffsetFrom.__init__`, `OffsetFrom._get_scale`(삭제), `OffsetFrom.__call__`, `_AnnotationBase.__init__`.
- **근본원인**: `self._ref_coord = ref_coord` 및 `self.xy = xy`가 호출자가 넘긴 mutable numpy 배열을 그대로 보관 → 호출 후 in-place 수정이 보관값에 전파.
- **수정요지**:
  - `_AnnotationBase.__init__`: `self.xy = xy` → `x, y = xy; self.xy = x, y`. 언패킹이 (a) 새 튜플로 복사하고 (b) 정확히 2개 원소가 아니면 `ValueError`로 shape를 검증한다.
  - `OffsetFrom.__init__`: 동일 패턴으로 `self._ref_coord = ref_coord` → `x, y = ref_coord; self._ref_coord = x, y`.
  - 부수 정리: `_get_scale` helper를 제거하고 `__call__` 내부에 `scale = 1 if self._unit == "pixels" else renderer.points_to_pixels(1)`로 인라인 — 기능 동치 리팩터(버그와 무관, 가독성).

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_annotate_and_offsetfrom_copy_input[png]` 1개. `check_figures_equal`로 두 figure를 비교: test 측은 `OffsetFrom(l, of_xy)`에 배열을 넘긴 뒤 `of_xy[:] = 1`로 변형, ref 측은 `annotate(xy=an_xy, xycoords=l)` 후 `an_xy[:] = 2`로 변형. 두 사이트가 모두 입력을 복사했어야 변형이 무시되고 두 그림이 동일해진다.
- **픽스 증명**: 복사 전이라면 `of_xy[:]=1`/`an_xy[:]=2`가 보관 좌표를 바꿔 두 figure가 달라져 실패. 골드의 언패킹 복사로 두 경로 모두 최초 `[.5,.5]`를 고정 → 그림 일치.
- **overfit/regression**: 테스트가 `OffsetFrom`과 `annotate(xycoords=Artist)` 두 경로를 동시에 검증하므로 `_AnnotationBase`만 고치면 통과 못 함 — 단일 사이트 overfit을 구조적으로 차단. P2P 98개(annotation_update, annotate_offset_fontsize, annotation_units 등)가 좌표/transform 정상경로를 회귀 검증.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "복사 대신 같은 배열 보관" + 링크된 `_AnnotationBase.__init__`에서 `self.xy = xy` 발견. 본문이 "`OffsetFrom`에도 같은 버그가 있을 수 있다"고 명시하므로 `text.py`에서 외부 입력을 그대로 필드에 저장하는 동족 사이트를 grep → `OffsetFrom.__init__`의 `self._ref_coord = ref_coord` 적발.
2. **픽스와 일반화**: 두 사이트 모두 `x, y = src; self.field = x, y`. 단순 `.copy()`보다 우월한 이유 — (a) tuple/list/array 모든 입력에서 새 불변 튜플로 복사, (b) 잘못된 shape(원소 ≠2)를 즉시 `ValueError`로 거부해 잠재 결함 클래스까지 좁힌다. 이게 special-case가 아닌 입력타입 전반 일반화.
3. **regression 안전**: `self.xy`/`self._ref_coord`를 소비하는 transform 경로(`OffsetFrom.__call__`, annotation 갱신)가 튜플도 받아들이므로 보관형 변경이 안전. P2P의 `test_annotation_update`/`test_annotate_offset_fontsize`/`test_annotation_units`가 이를 보증.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 실패는 (a) 이슈가 1순위로 찍어준 `_AnnotationBase`만 고치고 `OffsetFrom`을 빠뜨려 FAIL_TO_PASS 미통과, (b) `np.array(xy)`로 복사하면 shape 검증이 빠지고 `self.xy`가 ndarray가 되어 일부 downstream 비교에서 미묘한 차이 발생. 정답은 두 사이트 동시 수정 + 언패킹으로 복사·검증을 한 번에 얻는 것. `_get_scale` 인라인은 버그와 무관하므로 건드리지 않아도 통과하지만, 건드릴 땐 기능 동치를 유지해야 한다.
