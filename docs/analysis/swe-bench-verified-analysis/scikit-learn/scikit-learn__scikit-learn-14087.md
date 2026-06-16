---
instance_id: scikit-learn__scikit-learn-14087
repo: scikit-learn/scikit-learn
base_commit: a5743ed36fbd3fbc8e351bdab16561fbfca7dfa1
version: "0.22"
difficulty: "15 min - 1 hour"
created_at: "2019-06-13T20:09:22Z"
fail_to_pass: 3
pass_to_pass: 172
gold_files: [sklearn/linear_model/logistic.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`LogisticRegressionCV(refit=False).fit(X, y)`가 `IndexError: too many indices for array`를 던진다(0.21에서 신규 회귀, 0.20.3에서는 정상). 재현 코드와 네이티브 스택트레이스가 첨부돼 있고, 실패 지점은 `logistic.py`의 `fit` 내 `refit=False` 분기에서 `coefs_paths`를 4차원으로 인덱싱하는 `w = np.mean([coefs_paths[:, i, best_indices[i], :] ...])` 라인이다. 기본 `multi_class='auto'`일 때 발생한다.

## 유형 (정형화)
- **L1 (Traceable)**: 스택트레이스가 파일·라인·리스트컴프까지 정확히 지목한다. 그래도 "왜 `self.multi_class != 'ovr'` 분기를 타는가"를 알려면 위쪽 `multi_class = _check_multi_class(...)`(local) vs `self.multi_class`(raw) 차이를 추적해야 하므로 L0는 아니다.
- **S2 (Constraint-Reasoning) (+S1)**: 고칠 라인은 명확하나, 올바른 조건식을 추론으로 합성해야 한다. 핵심은 `self.multi_class`(원시 `'auto'`)를 `_check_multi_class`가 해소한 local `multi_class`(`'ovr'`/`'multinomial'`)로 바꾸는 것 — 인덱싱 차원(3D ovr vs 4D multinomial)이 *해소된* 값에 의존한다는 불변식을 짚어야 한다. l1_ratio_ 가드는 S1성(None-가드 템플릿).
- **K-Domain**: `coefs_paths` 텐서의 ovr/multinomial별 축 레이아웃, `auto` 해소 규칙, elasticnet에서만 l1_ratios가 의미 있다는 sklearn 내부 계약을 알아야 한다.
- **primary = T-ConstraintReason**: 위치는 거의 주어졌고 진짜 일은 "어떤 변수로 분기해야 차원이 맞는가"라는 조건 합성. CEGIS/반복생성이 아니라 한 번의 정확한 추론으로 풀린다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 단일 파일(`logistic.py`) · 골드 +5/-2줄(2 헌크) · localize 직접성 높음(스택트레이스 has-repro) · 도메인 추론 필요(텐서 축/auto 해소) · P2P 167개로 인접 동작 보존 압박(regression-trap). 1파일·소규모라 T1/T2로 끌리지만, 픽스가 "기계적 가드"가 아니라 raw-attr vs resolved-local 구분이라는 비자명한 인과를 요구해 T2를 넘는다. 공식 라벨 "15분-1시간"과 정합 — has-repro가 시간을 깎고, 차원 추론이 T1 아래로는 못 내려가게 한다.

## 골드패치 분석
- **파일·함수**: `sklearn/linear_model/logistic.py`의 `LogisticRegressionCV.fit` 내 `refit=False` (else) 분기.
- **근본원인**: 분기 조건이 `self.multi_class`(사용자가 넣은 원시값, 기본 `'auto'`)를 쓴다. 정작 `coefs_paths`의 축 개수는 위에서 `multi_class = _check_multi_class(...)`로 해소된 local 값(`'auto'`→`'ovr'` 또는 `'multinomial'`)에 따라 결정된다. `'auto'`가 ovr로 해소되면 `coefs_paths`는 3D인데 `self.multi_class != 'ovr'`라 4D 인덱싱 `coefs_paths[:, i, ...]` 분기를 타 IndexError. 더불어 `penalty != 'elasticnet'`이면 `l1_ratios_ = [None]`인데 무조건 `np.mean(l1_ratios_[best_indices_l1])`를 실행해 무의미/오류.
- **수정요지**: (1) `if self.multi_class == 'ovr'` → `if multi_class == 'ovr'`(해소된 local 사용). (2) `l1_ratio_` append를 `if self.penalty == 'elasticnet'`로 가드하고 아니면 `None` append.

## 검증 (test_patch)
- **FAIL_TO_PASS(3)**: `test_LogisticRegressionCV_no_refit`를 `penalty∈{l2,elasticnet}` × `multi_class∈{ovr,multinomial,auto}`로 확장해 신규 통과하는 건 `[ovr-l2]`, `[multinomial-l2]`, `[auto-l2]`. 기존 테스트는 `penalty='elasticnet'` 고정이라 `l1_ratios_`가 항상 다차원이어서 버그를 못 건드렸다 — 새 `l2` 케이스(특히 `auto-l2`)가 `multi_class` 해소 분기와 `[None]` l1_ratios 경로를 동시에 친다.
- **픽스 증명**: `auto-l2`는 두 결함을 모두 트리거(해소 분기 + None-가드)하므로 두 헌크 다 필요. local `multi_class`로 바꿔야 IndexError가 사라지고, elasticnet 가드가 있어야 `[None]`에 대한 잘못된 mean을 피한다.
- **overfit/regression**: l2 외 모든 elasticnet 케이스 + `test_LogisticRegressionCV_elasticnet_attribute_shapes`가 P2P에 포함돼 elasticnet 경로의 `l1_ratio_` 산출이 유지됨을 보장 — None-가드가 elasticnet을 망치지 않음을 검증. overfit 위험 낮음(픽스가 special-case 아닌 일반 분기 교정).

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스가 `logistic.py` 2193 라인 리스트컴프를 직접 지목 → 그 위 `if self.multi_class == 'ovr'`와 함수 상단 `multi_class = _check_multi_class(...)`를 비교, 두 심볼이 다른 값(raw `'auto'` vs resolved)임을 발견.
2. **픽스**: 분기 기준을 `self.multi_class`에서 해소된 local `multi_class`로 교체. 이게 올바른 일반화인 이유 — `coefs_paths`의 차원은 *실제로 적용된* multi_class에 의해 결정되므로, 동일한 해소 변수로 인덱싱 분기를 골라야 함수 전반(`if multi_class == 'multinomial'` 후처리 등)과 일관된다. 추가로 `penalty != 'elasticnet'`일 때 `l1_ratios_ == [None]`이므로 l1_ratio_ append를 elasticnet 가드 + `None` fallback으로 분리.
3. **regression 안전**: P2P의 elasticnet 계열(`[ovr/multinomial/auto-elasticnet]`, `*_elastic_net_*`, attribute_shapes)을 안 깨야 한다. local `multi_class`는 명시적 ovr/multinomial일 때 raw와 같으므로 기존 동작 보존, `auto`만 새로 올바르게 흐른다. elasticnet 가드는 elasticnet 분기에서 기존 코드와 byte-동일.
4. **함정 회피**: 오라클 없는 에이전트는 (a) IndexError만 보고 `try/except`나 차원 reshape로 증상 봉합(overfit), (b) `self.multi_class`를 그냥 두고 인덱싱 라인만 수정해 multinomial을 깸, (c) l1_ratio_ None-가드를 놓쳐 `l2-*` 케이스에서 2차 오류, 로 틀린다. 회피법: 분기와 텐서 축이 *해소된* multi_class에 함께 묶인다는 불변식을 먼저 세우고, l1_ratios가 elasticnet 전용이라는 도메인 계약을 명시적으로 가드.
