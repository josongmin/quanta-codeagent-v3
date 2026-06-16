---
instance_id: scikit-learn__scikit-learn-25747
repo: scikit-learn/scikit-learn
base_commit: 2c867b8f822eb7a684f0d5c4359e4426e1c9cfe0
version: "1.3"
difficulty: "15 min - 1 hour"
created_at: 2023-03-02T20:38:47Z
fail_to_pass: 1
pass_to_pass: 14
gold_files: [sklearn/utils/_set_output.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`set_config(transform_output="pandas")` 상태에서 `FeatureUnion`(또는 `ColumnTransformer`)에 행 개수를 바꾸는(집계/드롭) 커스텀 transformer를 넣으면 `ValueError: Length mismatch`가 난다. transformer가 이미 자기 index를 가진 DataFrame을 반환했는데, sklearn이 출력 wrapping 시 입력 index를 강제로 덮어쓰려다 길이가 안 맞아 터진다. `numpy` 출력에서는 정상. 재현 코드와 네이티브 스택트레이스가 `_set_output.py:59`를 정확히 지목한다.

## 유형 (정형화)

- **L (Localization) = L0**: 스택트레이스가 `_wrap_in_pandas_container`의 `data_to_wrap.index = index` 라인(`_set_output.py:59`)을 정확히 찍어준다. 이슈 본문은 GitHub permalink로 `#L55-L62` 블록까지 링크. grep 한 방, 단일 함수.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 위치는 자명하지만 "무엇을 어떻게 고칠지"는 추론이 필요하다. 단순히 try/except로 덮거나 길이 가드를 추가하는 게 아니라, "입력이 이미 DataFrame이면 transformer가 정한 index를 신뢰하고 index 재할당을 아예 하지 않는다"는 불변식을 합성해야 한다. hints_text가 "only set the index if it is not defined / less restrictive requirement"로 방향을 제시.
- **K (Knowledge) = K-Domain**: sklearn의 transform 출력 wrapping 계약(`_wrap_data_with_container`가 `original_input.index`를 전파하는 이유), "transform은 입력과 동일 샘플 수"라는 glossary 관례, DataFrame이 자체 index를 보유한다는 의미를 알아야 올바른 절충점을 잡는다.

**primary_type = T-ConstraintReason**: 위치는 명확(L0)하나 픽스가 기계적 가드가 아니라 "DataFrame 분기에서는 index를 보존한다"는 의미적 조건 합성이라 S2 dominant.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일 1개(`_set_output.py`), 코드 변경 -2줄(index 재할당 블록 삭제) + docstring 1줄 — 매우 작음.
- localize 직접성 최상(L0, has-repro) → 단독으론 T2를 시사.
- 그러나 픽스가 "삭제가 곧 정답"인 반직관적 결정이고, **regression-trap**이 있다: 기존 테스트 `test__wrap_in_pandas_container_dense_update_columns_and_index`가 "DataFrame 입력 시 index가 바뀐다"를 단언하고 있어 픽스와 동시에 그 단언을 뒤집어야 한다. 잘못 건드리면 columns 갱신 경로나 non-DataFrame 경로(`pd.DataFrame(..., index=index)`)를 깰 수 있다.
- 도메인 계약 추론(K-Domain)이 필요해 순수 기계적 픽스(T2)보다 한 단계 위.

공식 라벨 "15 min - 1 hour"와 정합. localize는 쉽지만 "index 복원을 없애도 되는가"의 설계 판단 + 기존 단언 수정 때문에 T1/T2로 내려가지 않는다.

## 골드패치 분석

- **건드린 파일·함수**: `sklearn/utils/_set_output.py`의 `_wrap_in_pandas_container`.
- **근본원인**: `data_to_wrap`가 이미 `pd.DataFrame`인 분기에서, columns 갱신 후 무조건
  ```python
  if index is not None:
      data_to_wrap.index = index
  ```
  로 입력 index를 덮어썼다. 호출부 `_wrap_data_with_container`가 `index=getattr(original_input, "index", None)`로 원본 입력 index를 넘기므로, transformer가 행 수를 바꾼 경우 길이 불일치(4 vs 96)로 `_validate_set_axis`가 ValueError.
- **수정요지**: DataFrame 분기에서 index 재할당 2줄을 **삭제**. transformer가 반환한 DataFrame의 index를 그대로 신뢰한다. docstring도 "`index` is ignored if `data_to_wrap` is already a DataFrame"로 계약을 명시. non-DataFrame 경로(`pd.DataFrame(data_to_wrap, index=index, columns=columns)`)는 그대로 두어 ndarray 출력엔 여전히 입력 index가 붙는다.

## 검증 (test_patch)

- **FAIL_TO_PASS** `test_set_output_pandas_keep_index`: `EstimatorWithSetOutputIndex`가 transform에서 `index=[f"s{i}"...]`로 새 index를 부여하고 `set_output(transform="pandas")`로 감싼 뒤, `X_trans.index == ["s0","s1"]`를 단언. 픽스 전이면 wrapping이 입력 index `[0,1]`로 덮어써(여기선 길이 동일이라 ValueError 대신 조용히 덮음) 단언 실패. 픽스 후엔 transformer index가 보존되어 통과 → 행 수 변경 시 ValueError도 사라짐(이슈 본질).
- **PASS_TO_PASS 갱신**: `test__wrap_in_pandas_container_dense_update_columns_and_index`가 `new_df.index == new_index` → `new_df.index == X_df.index`로 바뀜. DataFrame 입력 시 index 불변이라는 새 계약을 고정.
- **overfit 관점**: 픽스가 코드 삭제라 special-case 끼워맞춤이 아니라 분기 전체의 행동을 일반화 — overfit 위험 낮음. 단 FAIL_TO_PASS 1개라 얇긴 하나, 보존된 14개 P2P가 columns 경로·non-DataFrame 경로·에러검증을 커버.
- **regression 관점**: columns 갱신(`data_to_wrap.columns = columns`)과 ndarray→DataFrame 변환 경로가 P2P로 묶여 안전망 형성. index 삭제가 그쪽을 안 건드림을 보장.

## 모범답안 (오라클 기반)

1. **localize**: 스택트레이스 맨 아래 frame `_set_output.py:59 data_to_wrap.index = index` → `_wrap_in_pandas_container`의 DataFrame 분기로 직행. 이슈가 건 permalink가 동일 블록 확인.
2. **픽스와 일반화**: 호출부가 `original_input.index`를 무조건 넘기는 구조라, 진짜 결함은 "이미 자기 index를 가진 DataFrame에 입력 index를 강제 복원"하는 것. 가드(`len` 비교)로 때우면 행 수가 같지만 의미가 다른 index까지 덮는 잠재버그가 남는다. 올바른 일반화는 **DataFrame 분기에서 index 재할당 자체를 제거** — transformer가 출력한 index가 곧 진실이라는 계약. docstring에 "index ignored if already DataFrame" 명시로 의도 고정.
3. **regression 안전**: columns 갱신 라인과 마지막 `pd.DataFrame(..., index=index, columns=columns)`(ndarray 입력 경로)는 건드리지 않는다. ndarray 출력엔 여전히 입력 index가 붙어야 하므로(대부분의 transformer가 행 수 보존) 그 경로의 index 전파를 깨면 광범위 회귀. P2P의 `_dense`/`error_validation` 계열이 이를 지킨다.
4. **함정 회피**: (a) 오라클 없는 에이전트는 기존 `..._update_columns_and_index` 단언이 "index 바뀜"을 요구하니 그걸 "통과시켜야 할 스펙"으로 오해해 index 삭제를 주저하기 쉽다 — 이 단언은 함께 뒤집어야 할 낡은 계약. (b) `len(index)==len(data)` 가드로 ValueError만 막는 미봉책은 hints의 "less restrictive" 의도(transformer가 정한 index 신뢰)를 못 살리고 FAIL_TO_PASS의 index 보존 단언을 통과 못 함. (c) non-DataFrame 경로의 `index=index`까지 같이 지우면 정상 transformer의 index 전파가 깨져 대규모 회귀.
