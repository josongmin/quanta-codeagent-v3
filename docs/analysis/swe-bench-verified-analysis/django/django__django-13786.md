---
instance_id: django__django-13786
repo: django/django
base_commit: bb64b99b78a579cb2f6178011a4cf9366e634438
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-12-17T21:10:10Z
fail_to_pass: 1
pass_to_pass: 33
gold_files: [django/db/migrations/operations/models.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-13786

## 문제 요약
`squashmigrations`가 `CreateModel`과 그 뒤따르는 `AlterModelOptions`를 하나로 최적화(reduce)할 때, 모델 옵션을 "지우지" 못한다. 예컨대 `AlterModelOptions(name="test_model", options={})`처럼 옵션을 비우는 연산이 squash되면, 결과 `CreateModel`에는 기존 옵션이 그대로 남는다. 사용자는 빈 옵션이 최종 `CreateModel`에서도 제거되기를 기대한다. 근본은 `CreateModel.reduce()`가 `options={**self.options, **operation.options}`라는 단순 dict 병합만 수행해, `operation.options`에 빠진 키(= 제거 의도)를 표현하지 못하는 것. 반면 정상 마이그레이션 적용 경로인 `AlterModelOptions.state_forwards()`는 `ALTER_OPTION_KEYS` 중 새 options에 없는 키를 pop하여 "제거" 시맨틱을 가진다 — 두 경로의 시맨틱 불일치 버그.

## 유형 (정형화)

- **L (Localization) = L0 — Pinpointed.** problem_statement가 파일(`django/db/migrations/operations/models.py`), 함수(`CreateModel.reduce()`), 라인(144), 버그 표현식(`options={**self.options, **operation.options}`)을 모두 직접 지목하고, hints_text는 참조 구현(`AlterModelOptions.state_forwards`)과 써야 할 상수(`ALTER_OPTION_KEYS`)까지 명시. grep 한 방으로 분기에 도달. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S2 — Constraint-Reasoning.** 고칠 지점은 자명하나, 픽스는 "한 줄 치환"이 아니라 **올바른 제거 시맨틱을 추론으로 합성**해야 한다. 빈/부분 dict가 왜 "제거"를 의미하는지, 어떤 키 집합(`ALTER_OPTION_KEYS`)에 한정해 pop해야 하는지를 불변식 차원에서 따져야 함. "체크 추가/상수 변경"류의 기계적 S1이 아니라, `state_forwards`의 시맨틱을 reduce 경로에 정확히 옮기는 의미 보존(semantic-preserving) 합성이라 SemFix/Angelix 계열의 S2.
- **K (Knowledge) = K-Domain.** django migrations optimizer 내부지식 필요 — `reduce()` 최적화 프로토콜, `AlterModelOptions.ALTER_OPTION_KEYS`의 존재·의미(verbose_name/ordering/permissions 등 alter 대상 옵션 화이트리스트), `state_forwards`의 옵션 교체 동작을 알아야 픽스가 도출됨. 일반 파이썬 추론(K-Gen)만으로는 "왜 빈 dict가 삭제냐"가 안 풀린다.

**primary_type = T-ConstraintReason.** 위치는 명확(L0)하나 진짜 난점이 "올바른 조건·식을 추론 합성"(S2)에 있으므로 루브릭상 T-ConstraintReason. T-DirectMap이 아닌 이유: 픽스가 가드/기본값/상수 변경 같은 템플릿 매칭이 아니라, 제거 의미를 키-집합 한정 루프로 재구성하는 추론이 필요. T-DomainBound이 아닌 이유: K-Domain이 필요조건이긴 하나 dominant 병목은 "지식 회수"보다 "올바른 식 합성"이며, hints_text가 도메인 지식을 거의 떠먹여주어 지식 장벽이 낮아짐.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨 "15 min - 1 hour"(개발자 구현시간 기준, T2~T3 prior에 해당)보다 한 단계 위로 잡는다.

이 티어로 미는 구조적 피처:
- **S2 constraint-reasoning + K-Domain 조합** — 루브릭 T4 정의("constraint추론·소규모 refactor·도메인지식 중 하나")에 정확히 부합. localize는 L0로 매우 쉽지만, 픽스 정합성(제거 시맨틱 합성)이 비자명.
- **regression-trap (넓은 P2P)** — PASS_TO_PASS 33개가 전부 `OptimizerTests`로, optimizer reduce 경로를 광범위하게 커버한다. 단, `ALTER_OPTION_KEYS` 한정성을 직접 강제하는 P2P는 없다: 유일한 AlterModelOptions reduce P2P인 `test_create_alter_model_options`는 키가 `operation.options` 안에 있어 pop 자체가 안 일어나므로 무차별 pop 구현에서도 GREEN(상세는 검증 절). T4의 근거는 P2P-trap의 실증이 아니라 **제거 시맨틱을 올바른 키-집합으로 합성해야 하는 S2 constraint-reasoning + K-Domain 난점**에 있다.

공식 라벨과 다른 이유: 시간라벨은 "이 버그를 아는 코어 개발자의 구현시간"이라 hints가 있는 상태의 손쉬움을 반영하지만, **에이전트 관점의 정합성 위험(부분 제거 케이스2 + P2P 회귀)**은 시간라벨에 안 잡힌다. localize가 trivial(L0)이라 T5까지 가지는 않음 — 멀티파일/멀티헌크/overfit 고위험이 아니므로.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/migrations/operations/models.py` 의 `CreateModel.reduce()`, 구체적으로 `isinstance(operation, AlterModelOptions) and self.name_lower == operation.name_lower` 분기.
- **근본 원인:** 해당 분기가 새 `CreateModel`의 옵션을 `options={**self.options, **operation.options}`로만 산출. dict 언패킹 병합은 **합집합 + 덮어쓰기**만 하므로, `operation.options`에서 빠진 키(사용자가 제거하려는 옵션)는 `self.options`의 옛 값이 그대로 생존한다. 정상 적용 경로 `AlterModelOptions.state_forwards()`는 `ALTER_OPTION_KEYS` 중 새 options에 없는 키를 명시적으로 떨어내(교체 시맨틱) 제거를 구현하는데, reduce()는 이 제거 의미를 복제하지 못했다 — squash 경로 ↔ 적용 경로 시맨틱 불일치.
- **수정 요지:** 병합 dict를 먼저 `options = {**self.options, **operation.options}`로 만든 뒤, `for key in operation.ALTER_OPTION_KEYS: if key not in operation.options: options.pop(key, None)` 루프로 `operation.options`에 없는 alter 대상 키들을 정제해 떨어낸다. 그 정제된 `options`를 `CreateModel(...)`에 넘긴다. 즉 `state_forwards`의 옵션-교체 시맨틱을 reduce에서 동일 재현. 키 집합을 `ALTER_OPTION_KEYS`로 한정한 것이 핵심 — alter가 관리하는 옵션만 제거하고, 그 외(예: `db_table` 등 다른 연산 소관) 키는 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_create_model_and_remove_model_options (migrations.test_optimizer.OptimizerTests)`.
- **픽스 증명:**
  - 케이스1: `CreateModel(options={'verbose_name': 'My Model'})` + `AlterModelOptions(options={})` → 기대 `CreateModel(fields=[])` (옵션 전부 제거). 버그 코드는 `verbose_name`이 잔존해 실패; 픽스는 빈 `operation.options` 때문에 `verbose_name`이 `ALTER_OPTION_KEYS` 루프에서 pop되어 통과.
  - 케이스2 (부분 제거): `CreateModel(options={'verbose_name', 'verbose_name_plural'})` + `AlterModelOptions(options={'verbose_name': 'My Model'})` → 기대 `verbose_name`만 남고 `verbose_name_plural` 제거. `verbose_name_plural`이 `operation.options`에 없으므로 pop. 단, 이 케이스2는 `ALTER_OPTION_KEYS` **한정 여부를 구별하지 못한다**: 사용된 키 `verbose_name`·`verbose_name_plural`가 둘 다 `ALTER_OPTION_KEYS` 멤버라(base `models.py` L643-664), "operation.options에 없는 **모든** 키를 pop"하는 무차별 구현에서도 `verbose_name_plural`은 똑같이 pop되어 케이스2가 GREEN으로 통과한다. 케이스2가 실제로 차단하는 것은 "빈 dict면 옵션 통째로 비우기" 류 special-case(케이스2에서 `verbose_name`이 살아남아야 함)이지, `ALTER_OPTION_KEYS` 한정성이 아니다.
  - `assertOptimizesTo`로 optimizer를 실제로 돌려 squash 결과 operation 리스트가 기대치와 정확히 일치하는지 비교(effect 관찰형, 강한 단언).
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇아 보이나, 내부에 2개 단언(전체 제거 + 부분 제거)이 있어 special-case 패치(예: "빈 dict면 옵션 통째로 비우기")를 케이스2가 차단한다 → overfit-risk 플래그 미부여. 단, 입력공간(다양한 ALTER_OPTION_KEYS 조합) 전수는 아니므로 S4까지 가는 고위험은 아님.
- **regression 관점:** PASS_TO_PASS 33개 전부 `OptimizerTests`. 골드패치가 `ALTER_OPTION_KEYS ∩ (operation.options에 없는 키)`로 좁게 한정한 것은 올바른 도메인 설계지만, **이 한정성을 강제하는 P2P 테스트는 실재하지 않는다.** 유일한 AlterModelOptions reduce 분기 P2P인 `test_create_alter_model_options`(base test `test_optimizer.py` L114-118)는 `CreateModel('Foo', fields=[])` + `AlterModelOptions(options={'verbose_name_plural': 'Foozes'})`로, 유일한 키 `verbose_name_plural`가 `operation.options` 안에 있어 `key not in operation.options` 조건에 안 걸린다 → 어떤 pop도 발생하지 않으므로 무차별 pop 구현에서도 GREEN. 나머지 32개는 AlterModelOptions 분기를 타지 않아 무영향. 즉 `ALTER_OPTION_KEYS` 밖 옵션 키가 reduce 분기를 통과하며 살아남아야 하는 P2P 케이스가 33개 어디에도 없으므로, regression-trap의 실증 근거는 없다(올바른 일반화이긴 하나 테스트가 강제하지는 않음).

## 모범답안 (오라클 기반)
이상적 풀이 궤적 4단계:

1. **localize 경로:** problem_statement가 파일·함수·라인·버그식을 직접 준다 → `django/db/migrations/operations/models.py`의 `CreateModel.reduce()`에서 `isinstance(operation, AlterModelOptions)` 분기를 곧장 연다. hints_text의 포인터를 따라 같은 파일의 `AlterModelOptions.state_forwards()`와 클래스 상수 `ALTER_OPTION_KEYS`를 reference로 확보. (L0이라 탐색 거의 불필요.)

2. **픽스와 왜 올바른 일반화인가:** 버그는 dict 병합이 "제거"를 표현 못 하는 것. `state_forwards`가 이미 정답 시맨틱(= 새 options에 없는 `ALTER_OPTION_KEYS` 키를 떨어냄)을 갖고 있으므로, **그 시맨틱을 reduce 경로에 그대로 이식**한다: 병합 후 `operation.ALTER_OPTION_KEYS` 중 `operation.options`에 없는 키만 pop. 이것이 올바른 일반화인 이유 — 임의 키를 비우는 것이 아니라 "alter 연산이 관리하는 옵션 화이트리스트"에 한정하므로, 빈 dict(전체 제거)·부분 dict(선택 제거)·추가 dict(덮어쓰기) 모든 경우를 한 규칙으로 일관되게 처리. 두 경로(squash/apply)의 시맨틱을 일치시키는 것이라 특정 테스트가 아니라 도메인 불변식을 만족.

3. **regression 안전:** 깨지 말아야 할 핵심 P2P는 `test_create_alter_model_options`(옵션 추가/덮어쓰기). pop을 `ALTER_OPTION_KEYS`로 한정하고 `key not in operation.options` 조건을 걸었으므로, 새로 추가/유지되는 옵션은 절대 건드리지 않는다. 나머지 32개 OptimizerTests(필드/모델 reorder, delete, rename 등)는 AlterModelOptions 분기를 타지 않으므로 무영향. 무차별 pop이나 `self.options` 직접 변형(in-place 부작용)을 피하면 회귀 0.

4. **함정 회피:** 오라클 없는 에이전트의 오답 후보 —
   - (a) merge만 보고 "덮어쓰기"로 이해 → 제거 케이스 자체를 못 잡음(FAIL_TO_PASS RED).
   - (b) "빈 dict면 옵션 전체 비우기" 같은 special-case → 케이스2(부분 제거)에서 RED. 단언 2개가 이 overfit을 차단.
   - (c) `ALTER_OPTION_KEYS` 한정 없이 `operation.options`에 없는 모든 키 pop → alter 소관 밖 옵션까지 삭제하는 도메인상 잘못된 일반화. 단, 이 오답은 **테스트로는 적발되지 않는다**(test_patch 케이스1·2와 P2P 33개 모두 GREEN 통과) — `ALTER_OPTION_KEYS` 밖 키가 reduce 분기를 통과하며 살아남아야 하는 케이스가 부재하기 때문. 따라서 (c)는 회귀 RED 함정이 아니라 "테스트가 못 잡는 도메인 정합성 함정"이며, hints/`state_forwards` 참조로만 회피 가능.
   회피법: 추측으로 패치하지 말고 **`AlterModelOptions.state_forwards`의 제거 코드를 먼저 읽어 정답 키집합/조건을 그대로 차용**한다. 이미 검증된 시맨틱을 복제하는 것이 합성보다 안전하고, hints_text가 정확히 이 경로를 가리킨다.
