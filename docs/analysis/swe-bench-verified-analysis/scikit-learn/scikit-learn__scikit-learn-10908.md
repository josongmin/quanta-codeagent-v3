---
instance_id: scikit-learn__scikit-learn-10908
repo: scikit-learn/scikit-learn
base_commit: 67d06b18c68ee4452768f8a1e868565dd4354abf
version: "0.20"
difficulty: "15 min - 1 hour"
created_at: 2018-04-03T03:50:46Z
fail_to_pass: 1
pass_to_pass: 47
gold_files: [sklearn/feature_extraction/text.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`CountVectorizer(vocabulary=...)`처럼 생성자에서 vocabulary를 직접 주면 `transform`은 학습 없이도 동작하지만(`transform`이 `_validate_vocabulary`를 호출해 `vocabulary_`를 세팅하므로), `get_feature_names`는 `NotFittedError`를 던진다. 이슈는 fixed vocabulary가 제공되었으면 `get_feature_names`도 fit 없이 feature 이름을 돌려줘야 한다고 명세한다. 즉 두 진입점 간 동작 비대칭이 버그다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 메서드(`get_feature_names`), 비교 대상(`transform`), 핵심 헬퍼(`_validate_vocabulary`)를 본문에 직접 적어준다. grep 한 방으로 `text.py`의 해당 메서드 도달.
- **S2 Constraint-Reasoning (+S5)**: 고칠 줄은 자명하나, "언제 lazy하게 `_validate_vocabulary`를 불러야 하는가"라는 조건식을 추론으로 합성해야 한다. `transform`의 동작 계약(생성자 vocabulary면 fit 불필요)을 스펙으로 재구성(S5)해 그 불변식을 `get_feature_names`로 이식하는 것이 본질이다. 무조건 `_validate_vocabulary`를 부르면 이미 fit된 객체의 상태를 덮어쓰는 회귀가 생기므로 가드 조건(`if not hasattr(self, 'vocabulary_')`)이 필수.
- **K-Domain**: `_validate_vocabulary`/`_check_vocabulary`/`fixed_vocabulary_`/`check_is_fitted`의 상호작용이라는 sklearn vectorizer 내부 계약 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 픽스가 "체크 추가"의 기계적 S1이 아니라, 호출 순서·idempotency·기존 fit 상태 보존을 따지는 조건 합성이라 T-ConstraintReason.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 1파일·gold 3줄 삽입·함수 1개(`get_feature_names`) → scope는 T1~T2급으로 작다. has-repro(이슈에 완전한 재현 세션)도 easiness 신호. 그러나 T1/T2로 안 내리는 이유는 (1) 픽스가 단순 가드가 아니라 lazy-validate 패턴이고 `hasattr` 가드 없이 짜면 기존 fit 상태를 깨는 함정이 있으며, (2) `transform`/`_validate_vocabulary`/`_check_vocabulary`의 상태머신을 이해해야 올바른 조건을 도출하기 때문. 또 P2P 47개로 인접 vectorizer 동작(pickling, custom vocab, max_features 등)을 안 깨야 하는 regression-trap이 존재. 공식 라벨 "15 min - 1 hour"과 정합 — 단순 1줄보다 조금 더 추론을 요구.

## 골드패치 분석

- **건드린 파일·함수**: `sklearn/feature_extraction/text.py`의 `VectorizerMixin.get_feature_names`.
- **근본원인**: `get_feature_names`가 곧장 `self._check_vocabulary()`를 호출하는데, `_check_vocabulary`는 `check_is_fitted(self, 'vocabulary_')`로 `vocabulary_` 속성 존재를 요구한다. 생성자 vocabulary는 `_validate_vocabulary`가 호출될 때(`fit`/`transform` 경로) 비로소 `vocabulary_`로 materialize되므로, fit 전 `get_feature_names`는 `vocabulary_`가 없어 `NotFittedError`를 던진다. `transform`은 999행 근처에서 `_validate_vocabulary`를 먼저 부르기 때문에 비대칭이 발생.
- **수정요지**: `_check_vocabulary()` 직전에 lazy 부트스트랩 추가 —
  ```python
  if not hasattr(self, 'vocabulary_'):
      self._validate_vocabulary()
  ```
  `_validate_vocabulary`는 생성자 vocabulary가 있으면 `vocabulary_`와 `fixed_vocabulary_=True`를 세팅하고, 없으면 `fixed_vocabulary_=False`만 두므로(여전히 `vocabulary_` 미존재) 이후 `_check_vocabulary`가 정상적으로 `NotFittedError`를 던진다. `hasattr` 가드가 이미 fit된 객체에는 무영향(idempotent)이라 회귀 안전.

## 검증 (test_patch)

- **FAIL_TO_PASS**: `test_feature_names` 한 개. 패치된 테스트가 두 시나리오를 검증 — (a) 미학습/빈 vocab일 때 `get_feature_names`가 여전히 `ValueError`(NotFitted)를 던지고 `cv.fixed_vocabulary_`가 False(`assert_false`), (b) 신규 추가된 custom vocabulary 블록: `CountVectorizer(vocabulary=vocab)` 후 **fit 없이** `get_feature_names()`가 정렬된 feature 이름을 반환하고 `cv.fixed_vocabulary_`가 True이며 인덱스 매핑이 일치.
- **픽스 증명**: (b)는 lazy `_validate_vocabulary` 호출이 없으면 `NotFittedError`로 실패 → 가드가 동작함을 직접 증명. (a)는 vocabulary 미제공 시 `_validate_vocabulary`가 `vocabulary_`를 만들지 않아 여전히 거절됨을 증명(over-correction 방지).
- **overfit/regression 관점**: FAIL_TO_PASS가 1개지만 부정 케이스(a)와 긍정 케이스(b)를 한 테스트에 같이 둬 special-case 우회를 차단 — overfit 위험 낮음. 다만 `assert_raises`가 `ValueError` 부모로 잡아 정확한 메시지까지는 안 봄. P2P 47개(`test_countvectorizer_*`, pickling, vocab_sets/dicts)가 `vocabulary_` 상태 보존을 광범위 보증.

## 모범답안 (오라클 기반)

1. **localize**: 이슈 본문이 `get_feature_names` → `NotFittedError`, 그리고 "`transform`이 `_validate_vocabulary`를 불러 `vocabulary_`를 세팅한다"는 인과를 직접 진술. `text.py`에서 `def get_feature_names`로 점프 → 첫 줄 `self._check_vocabulary()`가 범인. `_check_vocabulary`와 `_validate_vocabulary` 정의를 읽어 `vocabulary_` 존재 의존을 확인.
2. **픽스와 일반화**: `transform`이 이미 쓰는 lazy 패턴을 그대로 차용 — `_check_vocabulary` 앞에 `if not hasattr(self, 'vocabulary_'): self._validate_vocabulary()`. 이게 올바른 일반화인 이유: `_validate_vocabulary`가 vocabulary 유무에 따라 분기하므로 "생성자 vocab 있으면 통과, 없으면 거절"이 자동으로 둘 다 보존됨. 무조건 호출이 아닌 `hasattr` 가드라 이미 fit된 경우엔 no-op.
3. **regression 안전**: `hasattr` 가드 덕에 fit 후 `vocabulary_`/`fixed_vocabulary_`를 재계산·덮어쓰지 않음 → `test_fit_countvectorizer_twice`, pickling 계열, `test_countvectorizer_custom_vocabulary*` 같은 P2P가 안전. vocab 없는 unfitted 객체는 여전히 `NotFittedError`를 받아 기존 계약 유지.
4. **함정 회피**: (a) 가드 없이 `self._validate_vocabulary()`를 무조건 부르면 fit된 객체 상태를 다시 써 미묘한 회귀 발생 — `hasattr` 가드 누락이 가장 흔한 실수. (b) `get_feature_names`에 try/except로 `NotFittedError`를 삼키면 vocab 미제공 케이스(a)까지 통과시켜 `assert_false(cv.fixed_vocabulary_)`/거절 계약을 깨는 over-correction. (c) `_check_vocabulary` 자체를 손대면 `transform`/`inverse_transform` 등 다른 호출처에 부수효과 — 수정은 `get_feature_names` 국소로 한정해야 함.
