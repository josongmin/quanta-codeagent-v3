---
instance_id: django__django-16595
repo: django/django
base_commit: f9fe062de5fc0896d6bbbf3f260b5c44473b3c77
version: 5.0
difficulty: <15 min fix
created_at: 2023-02-24T10:30:35Z
fail_to_pass: 1
pass_to_pass: 37
gold_files: [django/db/migrations/operations/fields.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-16595

## 문제 요약
마이그레이션 옵티마이저가 같은 필드에 대한 연속된 여러 `AlterField` 연산을 하나로 합치지 못한다. `AddField`가 함께 있으면 `AlterField`들이 `AddField`로 흡수되어 사라지지만, `AddField`가 분리되어 있는 경우(non-elidable 마이그레이션, 비-squash 마이그레이션 등) `optimizer.optimize(operations[1:], "books")`를 돌리면 `AlterField` 세 개가 그대로 남는다. 사용자는 동일 필드를 반복 변경하는 `AlterField`들이 마지막 하나로 축약되기를 기대한다. problem_statement에 재현 operations 리스트와 실제/기대 출력, 그리고 후보 패치 스니펫까지 포함되어 있다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 "Indeed, the `AlterField.reduce` does not consider the case where operation is also an `AlterField`"라고 파일/클래스/메서드를 직접 지목한다. `AlterField` + `reduce` 키워드로 `django/db/migrations/operations/fields.py`의 `AlterField.reduce`에 grep 한 방으로 수렴. 후보 다수 없음.
- **S (Repair Strategy) = S1 Direct-Map (+S2 Constraint-Reasoning)**: 이슈가 사실상 픽스를 명세한다 — 첫 `isinstance` 분기에 `AlterField` 케이스를 추가하면 끝. 정형 결함클래스(누락 case 추가)에 템플릿 매칭되므로 dominant는 S1. 보조 S2인 이유는, 단순히 새 분기를 추가(별도 `if AlterField → return [operation]`)할 수도 있지만 올바른 일반화는 기존 `RemoveField` 분기와 **합치는 것**(둘 다 "뒤 연산으로 collapse"라는 동일 불변식을 공유)임을 추론해야 하고, `is_same_field_operation` 가드를 반드시 유지해야 의미적 정합이 깨지지 않는다는 판단이 필요하기 때문. 그 추론이 가벼워 S1이 우세.
- **K (Knowledge) = K-Domain**: django migration optimizer의 `reduce` 프로토콜 — 각 operation이 후속 operation을 받아 "축약 결과 리스트"를 돌려주고, 같은 필드(`is_same_field_operation`)에 대한 후속 변경이면 나중 상태만 남으면 충분하다는 도메인 의미를 알아야 픽스가 올바르다. 일반 파이썬 추론만으론 "collapse 방향이 first가 아니라 second"임이 자명하지 않다.
- **Primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적(S1, 누락 case 추가)이므로 T-DirectMap. T-LocTrivial이 아닌 이유는 픽스가 완전 자명한 가드 한 줄이 아니라 `RemoveField` 분기와의 통합·collapse 방향이라는 도메인 의미를 한 톤 얹기 때문. T-DomainBound가 아닌 이유는 도메인 지식이 병목이 아니라 이슈가 답을 이미 적어줘서, K-Domain은 "정당성 확인"에만 필요하기 때문.

## 난이도 티어
- **Tier = T2 (쉬움)**.
- 이 티어로 미는 구조적 피처: (1) 1파일·1메서드·실질 2줄 수정(`fields.py`의 `AlterField.reduce` 단일 분기) — 구조적 컷 "1파일·<5줄 ≈ 48% solve" 구간. (2) **has-repro** — 재현 코드와 기대/실제 출력이 명시되어 가장 강한 easiness 신호. (3) L0 직접 지목 + S1 기계 픽스. (4) 단, 순수 T1이 아닌 것은 약한 S2(분기 통합·collapse 방향)와 **regression-trap**(아래) 때문에 한 단계 올림.
- 공식 difficulty 라벨 `<15 min fix`와 **일치**(T1/T2 둘 다 시간라벨에 부합). T1이 아니라 T2로 잡은 근거는 PASS_TO_PASS 37개 중 `RenameField`/`RemoveField`/`Alter*Together` 상호작용 케이스가 다수라, `is_same_field_operation` 가드를 빠뜨리거나 `RemoveField` 흡수 동작을 깨면 인접 동작이 회귀하는 trap이 존재 — 이 regression 위험은 시간라벨에 안 잡히는 피처이고 이를 T2로 반영했다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/migrations/operations/fields.py` : `AlterField.reduce`.
- **근본 원인**: `AlterField.reduce`의 첫 분기가 `isinstance(operation, RemoveField)`만 검사했다. 후속 연산이 같은 필드에 대한 또 다른 `AlterField`인 경우를 다루지 않아, 동일 필드 변경이 누적될 때 마지막 상태만 남기면 됨에도 모든 중간 `AlterField`가 살아남았다. 다른 Alter 계열(`AlterModelTable`/`AlterUniqueTogether`/`AlterIndexTogether`/`AlterOrderWithRespectTo`)은 이미 "두 번째로 collapse"하는데 `AlterField`만 그 경로가 빠진 비대칭이 본질.
- **수정 요지**: 해당 분기의 검사 대상을 `RemoveField` 단일에서 `(AlterField, RemoveField)` 튜플로 확장:
  ```python
  if isinstance(
      operation, (AlterField, RemoveField)
  ) and self.is_same_field_operation(operation):
      return [operation]
  ```
  `is_same_field_operation(operation)`이 참이면 `[operation]`(= 뒤쪽 연산)을 반환하여, 같은 필드를 다시 바꾸는 `AlterField`가 들어오면 이전 `AlterField`를 버리고 나중 것으로 collapse한다. `RemoveField`의 기존 흡수 동작은 동일 반환 경로를 재사용하므로 그대로 유지된다(별도 분기 추가가 아니라 통합이 올바른 일반화).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_alter_alter_field` — 같은 모델/필드(`Foo.name`)에 대한 두 `AlterField`(`IntegerField()` → `IntegerField(help_text="help")`)가 두 번째 것으로 collapse되는지 `assertOptimizesTo`로 단언.
- **픽스 증명 방식**: 기존 헬퍼 `_test_alter_alter_model`을 `_test_alter_alter`로 일반화(docstring도 "/AlterField" 추가)하고, 이 헬퍼는 `[alter_foo, alter_bar]`가 `[alter_bar]` 하나로 최적화됨을 단언한다. 신규 `test_alter_alter_field`가 이 헬퍼를 `AlterField` 입력으로 호출. 패치 전에는 두 `AlterField`가 그대로 남아 `assertOptimizesTo([...2개...], [...1개...])`가 실패한다.
- **overfit 관점**: FAIL_TO_PASS는 1개지만, 헬퍼가 `AlterModelTable`/`AlterUniqueTogether`/`AlterIndexTogether`/`AlterOrderWithRespectTo` 4개 케이스(P2P)와 동일 구조를 공유하므로 픽스가 "다른 Alter들과 대칭이 되었다"를 간접 검증. special-case로 통과하기 어려워 overfit 위험은 낮음. 단 테스트가 `is_same_field_operation`이 false인 "서로 다른 필드는 안 합쳐짐" 케이스를 직접 추가하진 않아 그 경계는 기존 P2P(RenameField/Remove 상호작용)에 의존.
- **regression 관점**: PASS_TO_PASS 37개에 `RemoveField should absorb AlterField`, `RenameField should optimize to the other side of AlterField`, `Alter*Together` collapse, create/alter/delete 시퀀스 등 인접 동작이 광범위. `(AlterField, RemoveField)` 튜플로 묶으면서 `RemoveField` 흡수와 `is_same_field_operation` 가드를 유지해야 이들이 안 깨진다 → regression-trap 플래그.

## 모범답안 (오라클 기반)
1. **Localize 경로**: 이슈 문장 "the `AlterField.reduce` does not consider the case where operation is also an `AlterField`"가 직접 포인터. `git grep "def reduce" django/db/migrations/operations/fields.py`로 `AlterField`/`RemoveField`/`RenameField`의 `reduce`를 나란히 보고, 다른 Alter 계열(`AlterModelTable` 등)의 `reduce`가 이미 "동일 대상 후속 Alter면 두 번째로 collapse"하는 것과 비교 → `AlterField.reduce`만 그 경로가 빠진 비대칭을 포착. 단일 메서드로 수렴.
2. **픽스와 올바른 일반화 근거**: 첫 분기를 `isinstance(operation, RemoveField)` → `isinstance(operation, (AlterField, RemoveField))`로 확장하고 `return [operation]`(뒤 연산)로 collapse. 이게 overfit이 아닌 이유: `is_same_field_operation` 가드가 "같은 model+field"를 보장하므로, 같은 필드를 거듭 바꾸는 모든 `AlterField` 체인에 일반적으로 적용되고(테스트의 특정 help_text 값에 의존하지 않음), 기존 `RemoveField` 흡수와 같은 불변식("후속 연산이 이전 상태를 무효화하면 마지막만 남긴다")을 공유한다. 별도 `if`를 추가하는 대신 튜플 통합이 코드 중복 없이 의미를 정확히 표현.
3. **Regression 안전**: `RemoveField`를 튜플에서 빼지 않아 `RemoveField should absorb AlterField` 등 기존 흡수가 보존된다. `is_same_field_operation` 가드를 유지해 서로 다른 필드의 `AlterField`는 합쳐지지 않아 `RenameField`/`Alter*Together`/create-alter-delete 시퀀스(P2P 37개)가 그대로 통과. collapse 방향을 first가 아닌 second(`[operation]`)로 둬야 다른 Alter 계열과 일관.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `is_same_field_operation` 가드를 빠뜨리고 무조건 `[operation]` 반환 → 다른 필드까지 잘못 합쳐 P2P 회귀. (b) collapse 방향을 first로 착각해 이전 `AlterField`를 남김. (c) `elif RenameField` 분기를 건드리는 과잉수정. (d) `RemoveField` 분기를 새 `AlterField` 분기로 대체해버려 기존 흡수 동작 파괴. 회피법: 이슈가 제시한 스니펫을 그대로 채택하되 **기존 `RemoveField`와 튜플로 묶는 미세 정리**만 하고, `is_same_field_operation` 가드와 `return [operation]`(second) 방향을 그대로 보존. P2P를 먼저 돌려 인접 Alter/Remove/Rename 케이스가 깨지지 않는지 확인.
