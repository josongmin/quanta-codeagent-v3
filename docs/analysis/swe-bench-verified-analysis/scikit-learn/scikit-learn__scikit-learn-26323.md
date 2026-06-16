---
instance_id: scikit-learn__scikit-learn-26323
repo: scikit-learn/scikit-learn
base_commit: 586f4318ffcdfbd9a1093f35ad43e81983740b66
version: "1.3"
difficulty: "15 min - 1 hour"
created_at: "2023-05-04T11:55:50Z"
fail_to_pass: 1
pass_to_pass: 188
gold_files: [sklearn/compose/_column_transformer.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`ColumnTransformer.set_output(transform="pandas")`가 하위 transformer들에는 출력 형식을 전파하지만, `remainder`가 estimator(예: `VarianceThreshold()`)로 지정된 경우 그 remainder는 무시한다. 결과적으로 remainder가 처리한 컬럼은 pandas DataFrame이 아닌 ndarray로 남고, 출력 결합 단계의 `feature_names_out` 기반 `if`가 어긋나 최종 결과가 잘못 조립된다. 이슈는 재현코드와 기대/실제 출력, 그리고 깨지는 정확한 라인 링크(L853)까지 제공한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 깨지는 메서드(`set_output`)와 누락된 객체(`remainder`)를 사실상 직접 지목한다. `grep "def set_output"` 한 방으로 단일 함수에 수렴.
- **S1 (Direct-Map)**: 결함 클래스가 정형적 "누락된 케이스 처리". 기존 루프가 `self.transformers`/`transformers_`만 chain하고 `self.remainder`는 별도 속성이라 빠졌다. 픽스는 동일 패턴(`_safe_set_output` 호출)을 remainder에 한 줄 추가하는 기계적 매핑.
- **K-Domain**: `remainder`가 `{"passthrough","drop"}` 문자열 sentinel일 수도, estimator일 수도 있다는 ColumnTransformer 내부 규약, 그리고 `_safe_set_output` 헬퍼의 존재를 알아야 정확히 짚는다. 일반 파이썬 추론만으론 sentinel 가드를 빠뜨리기 쉽다.
- **primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 가드+위임(S1)이라 ConstraintReason/SpecInference가 아니다. 식 합성이 아니라 빠진 분기 보충이 본질이므로 Direct-Map.

## 난이도 티어
**T2 (쉬움).** 구조적 피처: 1파일·1함수·실질 +4줄(빈 줄 포함, 실코드 +2줄), localize 직접성 최상(L0), 재현코드 있음. 도메인 지식은 sentinel 규약 정도로 얕다. 공식 라벨은 "15분-1시간"으로 T3에 걸칠 수 있으나, 이는 PR 작성·테스트 추가·CI 왕복 등 개발자 실측시간일 뿐 에이전트의 localize/픽스 난도는 낮다. 다만 P2P가 188건으로 넓어 `remainder`의 sentinel("passthrough"/"drop") 경로를 estimator 경로와 혼동하면 회귀를 유발할 수 있어(아래 regression-trap) T1까지 내리지 않고 T2로 둔다.

## 골드패치 분석
- **파일·함수**: `sklearn/compose/_column_transformer.py`의 `ColumnTransformer.set_output`.
- **근본원인**: `set_output`은 `chain(self.transformers, getattr(self, "transformers_", []))`를 순회하며 각 sub-transformer에 `_safe_set_output`을 호출한다. 그러나 `remainder`로 전달된 estimator는 이 두 컬렉션 어디에도 들어가지 않고 `self.remainder` 속성에만 보관되므로, 출력 설정이 전파되지 않는다.
- **수정요지**: 기존 루프 뒤에 sentinel 가드를 두고 remainder estimator에 출력 형식을 위임한다.
  ```python
  if self.remainder not in {"passthrough", "drop"}:
      _safe_set_output(self.remainder, transform=transform)
  ```
  `{"passthrough","drop"}` 체크는 remainder가 estimator일 때만 `_safe_set_output`을 부르도록 보장 — 문자열 sentinel에 `set_output`을 호출하는 오류를 막는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1건)**: `test_remainder_set_output`. `remainder=VarianceThreshold()`인 ColumnTransformer에 `set_output(transform="pandas")` 후 `fit_transform(df)`이 입력 DataFrame과 동일(`assert_frame_equal(out, df)`)함을 검증하고, 이어 `set_output(transform="default")`로 되돌리면 ndarray가 나오는지(`isinstance(out, np.ndarray)`)까지 확인한다. base에서는 remainder 컬럼이 ndarray로 남아 `assert_frame_equal`이 실패.
- **픽스 증명**: 패치로 remainder estimator가 pandas 출력으로 설정되면서 remainder 컬럼도 DataFrame으로 합쳐져 기대 출력과 일치.
- **overfit 관점**: 테스트가 pandas+default 양방향을 모두 검증하므로 special-case 통과가 어렵다. 다만 F2P가 1건이라 얇음 — 그래도 픽스가 기존 루프와 동일한 일반 헬퍼(`_safe_set_output`)를 재사용하므로 overfit 여지는 작다(overfit-risk 플래그 미부여).
- **regression 관점**: P2P 188건 중 `test_column_transformer_set_output[*]`, `test_column_transform_set_output_mixed[*-drop/passthrough]` 등이 sentinel remainder 경로를 덮는다. sentinel 가드가 없으면 "passthrough"/"drop" 문자열에 `_safe_set_output`을 호출해 이들이 깨질 수 있으므로, 가드가 회귀 방어의 핵심.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 제목("set_output ignores the remainder if it's an estimator")과 제공된 L853 링크 → `_column_transformer.py`. `set_output` 정의로 이동해 순회 대상이 `self.transformers`/`transformers_`뿐이고 `self.remainder`가 빠졌음을 확인.
2. **픽스**: 기존 루프와 같은 위임 헬퍼 `_safe_set_output`을 remainder에도 적용하되, remainder가 `"passthrough"`/`"drop"` 문자열일 수 있으므로 `not in {"passthrough","drop"}` 가드로 estimator일 때만 호출. 이는 special-case 하드코딩이 아니라 "모든 출력 보유 sub-estimator에 전파"라는 메서드 불변식을 remainder까지 일관 적용하는 올바른 일반화다.
3. **regression 안전**: sentinel 가드 덕분에 remainder가 문자열인 다수 P2P(set_output_mixed, set_output[drop/passthrough] 등)는 종전 그대로 no-op. 정상 transformer 전파 루프는 손대지 않으므로 인접 동작 불변.
4. **함정 회피**: (a) 가드 없이 무조건 `_safe_set_output(self.remainder, ...)`를 부르면 문자열 sentinel에서 터져 P2P 회귀 — 반드시 sentinel 제외. (b) remainder를 `transformers` 루프 안에 끼워 넣으려다 `verbose_feature_names_out`/feature-name 조립 로직의 순서를 흔들지 말 것. 픽스는 루프 외부에 독립적으로 추가하는 것이 안전. (c) `transformers_`(fitted)만 보고 미fit 상태에서 `set_output`을 부르는 경로를 놓치지 말 것 — `self.remainder`는 생성자 인자라 fit 여부와 무관하게 접근 가능.
