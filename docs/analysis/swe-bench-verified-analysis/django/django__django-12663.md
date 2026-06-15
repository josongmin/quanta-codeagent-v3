---
instance_id: django__django-12663
repo: django/django
base_commit: fa5e7e46d875d4143510944f19d79df7b1739bab
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-04-04T18:58:49Z
fail_to_pass: 1
pass_to_pass: 135
gold_files: [django/db/models/sql/query.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-12663

## 문제 요약
중첩된 Subquery 어노테이션을 `filter()`에 `SimpleLazyObject`(예: `request.user` 같은 지연 모델 인스턴스)와 함께 쓰면 `TypeError: int() argument must be ... not 'SimpleLazyObject'`로 깨진다. 커밋 35431298 이전에는 동작했으므로 회귀(regression)다. 사용자는 `.filter(user=request.user)`처럼 lazy 객체가 FK 룩업에서 자동으로 모델 인스턴스로 변환되길 기대했다. 네이티브 traceback이 함께 제공되어 진앙 추적이 명확하다.

## 유형 (정형화)
- **L = L0 (Pinpointed)** — traceback이 `sql/query.py:build_lookup` → `lookups.py:get_prep_lookup`의 `self.lhs.output_field`로 내려가고, 결정적으로 hints_text가 `Query.output_field`의 `self.select[0].field`(L235-236)를 줄 단위로 직접 지목한다. grep 한 방. 탐색 노력이 거의 0.
- **S = S2 (Constraint-Reasoning) +S1** — 고칠 지점은 명확하지만(L0), 픽스의 본질은 "`.field`가 아니라 `.target`을 써야 한다"는 **올바른 식의 합성**이다. `Col.field`(= `Expression.field`, output_field 별칭, 표현식 결과 타입)와 `Col.target`(실제 참조 필드 = ForeignKey)의 의미 차이를 추론해야 한다. 단순 None가드/상수변경(S1)이 아니라 "어떤 필드가 related-field 룩업 변환을 허용하는 올바른 output_field인가"를 불변식으로 따져야 하므로 dominant는 S2. 다만 최종 형태가 `getattr(select, 'target', None) or select.field` 한 줄 폴백 패턴이라 S1(가드 추가)의 기계적 성격도 보조로 깔린다.
- **K = K-Domain** — `Col.target` vs `Col.field`의 구분, related-field 룩업이 SimpleLazyObject를 모델 인스턴스로 풀어주는 메커니즘, Subquery → `query.output_field` → `select[0]` 데이터플로우는 전부 django ORM query-compiler 내부 지식이다. 일반 파이썬 추론으로는 "왜 target인가"를 도출할 수 없다. 모델빨이 병목.
- **primary type = T-DomainBound** — 위치는 L0로 자명하고 줄 수도 1줄이라 localize 난점(T-DiffuseLoc)도 아니고 픽스 명세형(T-DirectMap)도 아니다. 진짜 병목은 `field`/`target`이라는 프레임워크 내부 개념을 알아야 올바른 식을 합성할 수 있다는 점 — K-Domain이 dominant 축이라 T-DomainBound.

## 난이도 티어
**T4 (약간 어려움).** 구조적 피처:
- **파일 1개 / 프로덕션 수정 1줄(1헌크)** — scope 자체는 T1~T2급 (1파일·<5줄 ≈ 48% solve 구간).
- **has-repro** — 네이티브 traceback + 재현 모델/테스트케이스가 이슈에 포함(가장 강한 easiness 신호, ~87% 해결률). 이것 단독이면 티어를 낮춘다.
- 그러나 **K-Domain이 티어를 올린다** — `Col.field`와 `Col.target`의 구분은 ORM 내부지식이고, 이를 모르면 위치(L0)는 맞춰도 `lookups.py`나 `fields/__init__.py:get_prep_value`(traceback 최하단의 `int(value)`)를 고치려는 잘못된 방향으로 샌다. 루브릭 T4 정의의 "K-Domain 하나" 조건에 정확히 해당.
- **regression-trap (P2P 135개)** — `.target`만 단순 대입하면 비-Col select(annotation/aggregate, `target` 없음)에서 AttributeError가 나 `test_aggregate_subquery_annotation` 등 다수가 깨진다. 폴백 `or select.field`가 없으면 광범위 회귀.

**공식 라벨 "15 min - 1 hour"와의 비교:** 라벨은 개발자 구현시간 기준이며 traceback과 명확한 진앙 덕에 숙련 django 코어 개발자에겐 1줄로 빠르게 끝난다. 하지만 에이전트 난이도는 시간라벨에 안 잡히는 **`field` vs `target` 도메인 구분 + 폴백 필요성**에서 오므로 T2가 아닌 T4로 올린다(루브릭: localize 쉬움/도메인지식 병목은 시간라벨과 괴리). has-repro가 T5까지 올리는 건 막는다.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/models/sql/query.py` : `Query.output_field` (property)
- **근본 원인:** select가 단일 컬럼일 때(`len(self.select) == 1`) `output_field`로 `self.select[0].field`를 반환했다. `Col.field`는 `Expression.field`(= `output_field`의 별칭)이며 표현식의 결과 타입(일반 필드)을 돌려준다. select가 FK 컬럼을 가리켜도 일반 IntegerField류로 취급되어, 외곽 `filter`의 lhs.output_field가 FK가 아니게 되고 룩업이 RHS(SimpleLazyObject)를 `int()`로 강제 변환하려다 TypeError. lazy 객체를 모델 인스턴스로 풀어주는 related-field 룩업 변환은 실제 대상 필드(`Col.target`, 즉 ForeignKey)에서만 동작한다.
- **수정 요지:** `return self.select[0].field`를 다음으로 교체.
  ```python
  select = self.select[0]
  return getattr(select, 'target', None) or select.field
  ```
  select 원소가 `target`(Col)을 가지면 그 target(진짜 FK 필드)을 output_field로 쓰고, 없으면(`target` 미보유 표현식: annotation/aggregate) 기존 `.field`로 폴백한다. 이로써 외곽 filter가 FK 룩업으로 인식되어 SimpleLazyObject가 모델 인스턴스로 변환된다. hints의 원안 `return self.select[0].target`(폴백 없음)을 폴백 형태로 강건화한 것이 골드.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_subquery_filter_by_lazy (expressions.tests.BasicExpressionsTests)`
- **픽스 증명:** `tests/expressions/models.py`에 `Manager` 모델과 `Employee.manager = ForeignKey(Manager, CASCADE, null=True)`를 추가한다. 테스트는 `Employee.objects.filter(lastname=OuterRef('ceo__lastname')).values('manager')`로 FK 컬럼을 select하는 Subquery를 `Company.annotate(ceo_manager=...)`로 걸고, RHS로 `SimpleLazyObject(lambda: Manager.objects.get(pk=self.max.manager.pk))`를 넘겨 `.filter(ceo_manager=max_manager)`로 거른다. 픽스 전: `output_field`가 일반 필드 → lazy를 int로 변환 → TypeError. 픽스 후: `Col.target`(FK)이 output_field → related-field 룩업이 lazy를 인스턴스로 풀어줌 → `qs.get() == self.gmbh` 성립.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇아 보이나, 픽스 수단이 입력에 의존하지 않는 구조적 분기(`target` 존재 여부)라 special-case overfit이 아니다. 테스트가 FK-select 경로만 커버하지만 폴백 분기는 P2P가 커버한다. → overfit-risk 플래그 미부여.
- **regression 관점:** P2P 135개 중 `test_aggregate_subquery_annotation`, `test_subquery_filter_by_aggregate`, `test_nested_subquery*` 등 `target` 없는 표현식 select를 도는 케이스들이 `or select.field` 폴백을 검증한다. 폴백 누락 시 광범위 회귀 → regression-trap 플래그 부여 근거.

## 모범답안 (오라클 기반)
1. **localize 경로:** traceback 최하단부터 역추적 — `fields/__init__.py:968 int(value)`가 SimpleLazyObject를 못 받는다는 메시지는 **여기가 진앙이 아니라** lhs의 output_field가 잘못된 타입(FK여야 하는데 정수 필드)이라는 신호다. 한 단계 위 `lookups.py:get_prep_lookup`의 `self.lhs.output_field` → 그 위 `Query.output_field` property로 수렴. has-repro 덕에 grep 한 방(L0). hints가 명시적이지만 hints 없이도 traceback만으로 도달 가능.
2. **픽스와 왜 올바른 일반화인가:** `self.select[0].field`를 `getattr(select, 'target', None) or select.field`로. 핵심은 `.field`(표현식 결과 타입 별칭)가 아니라 `.target`(실제 참조 FK 필드)이 related-field 룩업 변환(lazy→instance)을 활성화한다는 것. special-case가 아닌 이유: 분기 기준이 입력값이 아니라 "select 원소가 Col인가(=실제 컬럼 참조인가)"라는 구조적 속성이라, FK뿐 아니라 모든 Col-backed 단일 select에 일반적으로 올바른 output_field를 준다.
3. **regression 안전:** `target`을 못 가진 select(annotation_select로 안 빠지는 비-Col 표현식, aggregate 등)는 `or select.field` 폴백으로 기존 동작을 그대로 보존해야 한다. P2P 135개 중 `test_aggregate_subquery_annotation`·`test_subquery_filter_by_aggregate`·`test_nested_subquery*` 군이 이 폴백 경로를 밟는다. 폴백 없이 `.target`만 쓰면 AttributeError로 대량 회귀.
4. **함정 회피:** 오라클 없는 에이전트의 오답 패턴 — (a) traceback 최하단 `int(value)`만 보고 `get_prep_value`에 SimpleLazyObject isinstance 가드를 추가(증상치료, 회귀 유발, related-field 변환 의미 상실). (b) `lookups.py`에서 lazy를 강제 평가(공개 API 아닌 SimpleLazyObject에 결합, 다른 룩업 깸). (c) hints의 원안 `return self.select[0].target`을 그대로 채택해 폴백 누락 → P2P 대량 RED. 올바른 회피법: `field`/`target` 의미 구분을 ORM 지식으로 확인하고, 폴백을 반드시 동반하며, P2P를 돌려 비-Col select 경로 안전을 검증.
