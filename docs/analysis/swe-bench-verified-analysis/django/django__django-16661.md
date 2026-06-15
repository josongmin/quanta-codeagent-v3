---
instance_id: django__django-16661
repo: django/django
base_commit: d687febce5868545f99974d2499a91f81a32fef5
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-03-18T09:26:58Z
fail_to_pass: 1
pass_to_pass: 36
gold_files: [django/contrib/admin/options.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro, overfit-risk]
---

# django__django-16661

## 문제 요약
`ModelAdmin.lookup_allowed()`이 PK가 외래키인 모델(`OneToOneField(..., primary_key=True)`)을 거치는 관계 lookup을 정상인데도 `DisallowedModelAdminLookup`으로 잘못 차단한다. `Restaurant.place`가 PK 역할의 `OneToOneField`일 때 `WaiterAdmin.list_filter`에 `restaurant__place__country`를 등록해도 admin이 이를 거부한다. 원인은 admin이 "FK를 PK로 가진 것"을 concrete inheritance(다중테이블 상속)와 동일시해서, lookup 경로 `restaurant__place__country`를 `restaurant__country`로 단축해 버리기 때문이다. 단축된 경로는 list_filter에 없으므로 차단된다. 같은 코드가 Django 1.8에서는 통과했고, 이슈는 회귀 도입 커밋(`8f30556`)까지 bisect되어 있다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)** — problem_statement이 실패 테스트 전문, 증상 예외명(`DisallowedModelAdminLookup`), 메서드명(`lookup_allowed`), 그리고 인과 가설("admin이 FK-as-PK를 concrete parent로 오인해 단축한다")까지 직접 적어준다. `lookup_allowed` grep 한 방이면 `django/contrib/admin/options.py`의 단일 함수에 도달한다. has-repro까지 있어 위치 탐색은 사실상 0.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)** — 고칠 줄(relation_parts 누적 루프의 단축 조건 `field not in prev_field.path_infos[-1].target_fields`)은 자명하나, **올바른 대체 조건식을 추론으로 합성**해야 한다. 기존 단축이 보호하던 정당한 케이스(진짜 상속 부모 링크, 자동 PK로 끝나는 `__id` lookup)는 통과시키면서 FK-as-PK만 배제하는 정밀한 불리언 조건을 _meta 불변식으로 따져 만들어야 한다. 후보를 여러 개 던져 테스트로 거르는 G&V가 아니라 "왜 무너지는가"를 이해해 한 번에 맞춰야 하는 semantic repair다.
- **K (Knowledge) = K-Domain** — Django `Model._meta` 내부 API(`parents`, `auto_field`, `path_infos`, FK의 `to_fields`)와 admin lookup 권한 모델, 다중테이블 상속의 parent link 표현을 알아야 한다. 일반 파이썬 추론으로는 "단축 로직이 왜 존재하는지"의 의도조차 복원 불가.

**primary type = T-ConstraintReason** — 위치는 명확(L0)하나 난점이 "올바른 조건식의 추론 합성"(S2)에 있다. S5(스펙 추론)가 아닌 이유는 의도가 코드+이슈로 충분히 결정되기 때문, S4(CEGIS)가 아닌 이유는 테스트가 정답 일반화를 비교적 잘 명세하기 때문(아래 overfit 항 참조).

## 난이도 티어

**Tier = T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"로 T3~T4 경계인데, 다음 구조적 피처가 T4로 민다:

- **단일 파일·단일 함수·소규모 헌크** (gold = `options.py` 한 헌크) → scope 자체는 작아 T5 이상은 아님.
- **K-Domain이 dominant** — 픽스의 핵심이 `_meta.parents` vs `_meta.auto_field` vs `to_fields`를 구분하는 도메인지식. 루브릭상 K-Domain 병목은 T4의 전형 프로파일.
- **S2 constraint 추론** — 조건을 단순히 지우면 인접 동작이 깨진다(아래 regression-trap). 3항 복합 조건을 정확히 합성해야 함.
- **regression-trap (P2P 36개)** — `test_lookup_allowed_onetoone`, `test_lookup_allowed`(존재 안 하는 필드 lookup 허용) 등 인접 동작이 같은 함수의 같은 분기를 지난다. 과교정하면 바로 깨진다.

has-repro(이슈 본문에 실행 가능한 실패 테스트)는 easiness 신호라 T5로 올라가는 걸 막지만, 도메인지식 + 정밀 조건 합성 + P2P trap의 결합이 T3보다 위로 민다. 공식 라벨과 큰 충돌은 없되, "에이전트가 _meta 의미를 모르면 과교정한다"는 위험은 시간라벨엔 안 잡히므로 T4로 고정.

## 골드패치 분석

- **건드린 파일·함수**: `django/contrib/admin/options.py` — `ModelAdmin.lookup_allowed(self, lookup, value)`. relation_parts를 누적하며 lookup 경로를 검증하는 루프 안의 단일 조건 분기.
- **근본 원인**: 경로 각 part마다 "이 값이 local model에서 이미 찾아질 수 있으면 relation_parts에 추가하지 말고 단축한다"는 최적화가 있다(예: `employee__department__id`는 `employee__department_id`로 이미 찾아짐). 그 단축 판정이 `field not in prev_field.path_infos[-1].target_fields`였다. PK가 FK인 경우(`OneToOneField(primary_key=True)`) 해당 FK의 `path_infos[-1].target_fields`가 그 FK 자신을 가리키게 되어, 정상적인 관계 part까지 "부모에서 찾아지는 값"으로 오판해 흡수한다. 그 결과 `restaurant__place__country`가 `restaurant__country`로 단축되고, list_filter 미등록으로 차단된다.
- **수정 요지**: 단축 조건을 `target_fields` 멤버십 비교에서 **실제 부모/PK 판정**으로 교체했다. part를 건너뛰려면 이제 다음을 모두 만족해야 한다:
  1. `field not in model._meta.parents.values()` — 진짜 concrete 상속의 parent link가 아닐 것,
  2. `field is not model._meta.auto_field` — 자동 생성 PK 자신이 아닐 것,
  3. `model._meta.auto_field is None or part not in getattr(prev_field, "to_fields", [])` — auto_field가 있는 모델에서 직전 FK의 `to_fields`로 끝나는 part(즉 `__id` 같은 자동 PK 경유)만 단축.

  핵심은 단축의 정당한 케이스(상속 부모 링크 + 자동 PK 경유)는 그대로 두고, FK-as-PK 관계 part는 단축에서 제외해 정상 relation_part로 유지하는 것.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_lookup_allowed_foreign_primary` — `@isolate_apps("modeladmin")`로 `Country → Place(country FK) → Restaurant(place=OneToOneField primary_key=True) → Waiter(restaurant FK)` 체인을 정의하고, `WaiterAdmin.list_filter = ["restaurant__place__country", "restaurant__place__country__name"]`로 등록.
- **픽스 증명**: 세 단언이 모두 `True`여야 한다 — `lookup_allowed("restaurant__place__country", "1")`, `lookup_allowed("restaurant__place__country__id__exact", "1")`, `lookup_allowed("restaurant__place__country__name", "test_value")`. 버그 코드에서는 경로가 `restaurant__country`로 단축되어 list_filter 미등록 → False. 픽스 후 단축이 일어나지 않아 정상 part 누적 → True.
- **overfit 관점 (overfit-risk)**: FAIL_TO_PASS가 단 1개 테스트지만 그 안에 3개 단언이 있고, 그중 `__id__exact`(자동 PK lookup)와 `__name`(일반 관계 끝 필드) 단언이 "단축을 그냥 다 끄면 깨지는" 케이스를 동시에 명세한다 — 즉 조건 3개를 다 짜야만 동시에 통과하므로 special-case 패치를 어느 정도 걸러낸다. 그래도 테스트 모델이 한 토폴로지뿐이라(다중 상속 + FK-PK 혼합 같은 조합 미검증) 미검증 입력공간은 남아 overfit-risk 플래그 유지.
- **regression 관점 (regression-trap)**: P2P 36개 중 `test_lookup_allowed_onetoone`, "A lookup_allowed allows a parameter whose field lookup doesn't exist."가 같은 함수의 같은 분기를 통과한다. 조건 (2)·(3)의 `auto_field` 가드가 깨지면 자동 PK로 끝나는 `__id` lookup 단축이 무너져 이들이 회귀한다.

## 모범답안 (오라클 기반)

1. **Localize 경로**: 이슈가 예외명 `DisallowedModelAdminLookup`과 메서드 `lookup_allowed`, 실패 재현 테스트를 직접 준다 → `grep "lookup_allowed" django/contrib/admin/options.py`로 `ModelAdmin.lookup_allowed` 단일 함수에 즉시 도달. relation_parts 누적 루프 안의 단축 조건 `field not in prev_field.path_infos[-1].target_fields`가 유일한 의심 지점. hints의 bisect 커밋 `8f30556`을 보면 이 줄이 회귀 도입점임을 확정할 수 있다.

2. **픽스와 왜 올바른 일반화인가**: 단축은 원래 "local model에서 이미 찾아지는 값"(자동 PK 경유 `__id`, 상속 부모 링크)을 건너뛰려는 최적화다. 버그는 `target_fields` 비교가 FK-as-PK에서 "정상 관계"마저 "부모에서 찾아짐"으로 오판하는 데 있다. 올바른 일반화는 단축 조건을 **의미가 명확한 _meta 구조**(`parents.values()` = 진짜 상속, `auto_field` = 진짜 자동 PK, `to_fields` = FK가 가리키는 대상 필드)로 재진술하는 것. 이러면 "FK가 PK"라는 우연한 형태가 아니라 "상속이냐 / 자동 PK 경유냐"라는 본질로 단축을 게이트하므로, 테스트의 한 토폴로지를 넘어 일반적으로 올바르다.

3. **Regression 안전**: `test_lookup_allowed_onetoone`(OneToOne 관계 lookup)과 "field lookup doesn't exist" 허용 테스트가 같은 분기를 지난다. 조건 (3) `auto_field is None or part not in to_fields`는 자동 PK로 끝나는 `__id` 단축을 보존하기 위한 것이라 반드시 유지해야 이들 P2P가 안 깨진다. 단축을 통째로 제거하는 naive 픽스는 FAIL_TO_PASS는 통과시켜도 이 P2P들을 회귀시킨다.

4. **함정 회피**: 오라클 없는 에이전트의 전형적 실패는 (a) `target_fields` 비교를 단순히 `if not prev_field:`로 약화하거나 단축 자체를 지워서 자동 PK lookup을 회귀시키는 과교정, (b) `_meta.parents`/`auto_field`/`to_fields`의 의미를 몰라 "왜 단축이 존재하는지" 의도를 복원하지 못하고 증상만 막는 ad-hoc 가드. 회피법: 단축의 원래 목적(상속 + 자동 PK 경유만 건너뛰기)을 먼저 복원하고, FAIL_TO_PASS의 `__id__exact`·`__name` 단언과 P2P의 `test_lookup_allowed_onetoone`을 동시에 만족하는지로 조건을 검증하면서 좁혀야 한다. has-repro와 bisect 커밋을 적극 활용하면 의도 복원이 쉬워진다.
