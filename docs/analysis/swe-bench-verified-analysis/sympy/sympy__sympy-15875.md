---
instance_id: sympy__sympy-15875
repo: sympy/sympy
base_commit: b506169ad727ee39cb3d60c8b3ff5e315d443d8e
version: "1.4"
difficulty: "<15 min fix"
created_at: 2019-01-29T03:18:51Z
fail_to_pass: 1
pass_to_pass: 80
gold_files: [sympy/core/add.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`is_zero`는 결정할 수 없으면 `None`을 줘야 하고 절대 틀린 답을 주면 안 되는데, `e = -2*I + (1 + I)**2` 에 대해 `e.is_zero`가 `False`를 반환한다(실제로는 `simplify(e).is_zero`가 `True`, 즉 0임). 이 잘못된 단정이 행렬 rank 계산에서 오류를 유발한다(#15872). 힌트에 따르면 `Add._eval_is_zero` 핸들러(#10298)가 들어온 뒤 생긴 regression 의심.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈 본문에 직접 심볼 포인터는 없으나 힌트가 `sympy/core/add.py` L532-566 `_eval_is_zero`를 정확히 지목한다. 사실상 핀포인트에 가깝지만 이슈 자체만으로는 한 단계 탐색이 필요해 L1.
- **S2 (Constraint-Reasoning)**: 고칠 함수는 자명하나, **올바른 가드 조건**(`len(nz) == 0`일 때 추론 불가→`None`)을 imaginary/real 누적 불변식을 따져 합성해야 한다. 여러 후보를 던져 테스트로 거르는 G&V가 아니라, 빈 `nz`에서 `b = self.func(*nz) == Add() == 0`이 되어 후속 `im` 분기가 거짓 단정을 내는 인과를 추론으로 봉합한다.
- **K-Domain**: sympy assumptions 시스템(`is_real`/`is_imaginary`/`is_zero`의 3-state fuzzy 논리, `S.ImaginaryUnit`)을 알아야 분기 의미를 읽는다.
- **primary = T-ConstraintReason**: 위치는 사실상 주어졌고 난점은 "어떤 조건일 때 None으로 빠져야 정답을 망치지 않는가"의 불변식 추론에 있다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·1함수·1줄(한 조건절 확장), `has-repro`(이슈에 재현 expr 명시)로 localize·검증이 쉬운 점은 난이도를 낮춘다. 그러나 (1) 픽스가 기계적 None-guard 템플릿이 아니라 빈 `nz`가 `Add()→0`으로 무너지는 의미적 인과 추론을 요구하고(S2), (2) `_eval_is_zero`는 광범위한 assumptions 질의가 의존하는 hot path라 78개 P2P regression-trap이 무겁다. 공식 라벨은 `<15 min fix`(T1~T2 prior)지만, 개발자 구현시간은 한 줄이어도 에이전트 관점의 **올바른 조건 합성 + regression 회피** 부담이 있어 T3로 상향.

## 골드패치 분석
- **파일·함수**: `sympy/core/add.py` 의 `Add._eval_is_zero`.
- **근본원인**: 루프에서 args를 분류해 실수 비영(non-zero) 항을 `nz`에 모은다. 모든 항이 imaginary거나 모두 zero인 실수항이면 `nz`가 빈 채로 남는다. 이때 `b = self.func(*nz)`가 인자 없는 `Add()`, 즉 `S.Zero`가 되어 `b.is_zero`가 무조건 `True`. 그러면 `im and not im_or_z` 분기를 타고 `-2*I + 2*I` 같은 (실제로는 0인) 식에 대해 `return False`를 내버린다 — 결정 불가 상황에서 틀린 단정.
- **수정요지**: 빈 `nz`를 추론 불가로 처리. `if len(nz) == len(self.args):` 를 `if len(nz) == 0 or len(nz) == len(self.args):` 로 확장해, 비영 실수항이 하나도 없으면 `b` 합성 전에 `return None`. `len(nz)==len(self.args)`(모두 비영 실수→상쇄 판정 불가)와 같은 "추론 불가" 게이트에 빈 케이스를 추가한 것.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_Add_is_zero` 에 `e = -2*I + (1 + I)**2; assert e.is_zero is None` 추가(Issue 15873). 패치 전: `(1+I)**2 == 2*I` 라 `e == -2*I + 2*I`, 두 항 모두 imaginary → `nz` 빈 채 `im=True`, `b=Add()=0`, `im and not im_or_z`로 `False` 반환 → assert 실패. 패치 후: `len(nz)==0`에서 즉시 `None` 반환 → 통과.
- **픽스 증명**: 빈 `nz`는 "비영 실수 성분이 없다"는 뜻이고, 남은 건 imaginary 성분들의 상쇄 여부인데 이 핸들러는 그걸 결정할 수단이 없다. 따라서 `None`(모름)이 정답 — `is_zero`의 핵심 계약("틀린 답 금지, 모르면 None")을 만족.
- **overfit/regression**: FAIL_TO_PASS가 단일 어서션이라 얇지만(overfit 여지), 픽스가 특정 expr이 아닌 "빈 nz 일반 클래스"를 None으로 빼므로 special-case가 아니다. 78개 P2P(`test_Pow_is_zero`, `test_mul_zero_detection`, `test_Add_is_*` 다수)가 기존 `True`/`False` 단정 경로를 그대로 유지하는지 확인 — `len(nz)>0` 경로는 한 글자도 안 바뀌어 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "`is_zero` False on `Add`" + 힌트가 가리킨 `add.py` `_eval_is_zero`로 직행(L1). `grep _eval_is_zero sympy/core/add.py`로 분기 로직 확인.
2. **픽스**: 재현 expr를 손으로 평가해 `(1+I)**2 → 2*I` 이므로 모든 args가 imaginary → 루프 후 `nz`가 비어 `b=Add()=0`이 되는 인과를 짚는다. 빈 `nz`에서는 상쇄 여부 결정 불가이므로 `len(nz)==0`을 기존 `None`-게이트(`len(nz)==len(self.args)`)에 OR로 합류. 특정 값이 아닌 구조 조건을 막으므로 올바른 일반화.
3. **regression 안전**: `len(nz)`가 0도 전체도 아닌 정상 경로(실수 비영항 존재)는 손대지 않아야 한다 — `z==len(self.args)`의 `True`, `b.is_zero` 기반 `True`/`False` 판정이 보존돼야 `test_Add_is_zero` 앞부분과 `test_Pow_is_zero` 등 78 P2P가 깨지지 않는다.
4. **함정 회피**: 흔한 오답은 (a) 재현 식만 보고 `e.is_zero` 결과를 `True`로 강제(여전히 모르는 경우엔 거짓말이 됨 — 계약 위반), (b) `b.is_zero` 분기 자체를 손대 다른 정상 단정을 무너뜨리는 것. 정답은 "결정 불가를 None으로 정직하게 후퇴"라는 fuzzy-logic 계약을 따르고, 변경을 빈 `nz` 게이트 한 곳으로 국소화하는 것.
