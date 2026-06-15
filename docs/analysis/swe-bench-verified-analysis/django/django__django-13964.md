---
instance_id: django__django-13964
repo: django/django
base_commit: f39634ff229887bf7790c069d0c411b38494ca38
version: "4.0"
difficulty: 15 min - 1 hour
created_at: 2021-02-02T17:07:43Z
fail_to_pass: 1
pass_to_pass: 36
gold_files: [django/db/models/base.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-13964

## 문제 요약
non-auto `CharField`를 primary key로 갖는 모델(`Product.sku`)을 FK로 참조하는 자식(`Order`)에서, 자식에 빈 부모 인스턴스를 먼저 할당하고(`order.product = Product()`) 나중에 부모의 pk를 채운 뒤 저장하면 데이터 손실이 발생한다. 기대는 `order.product_id`가 부모의 `sku` 값("foo")으로 채워지는 것이지만, 실제로는 빈 문자열("")로 저장되어 커밋 시 `ForeignKeyViolation`으로 트랜잭션이 깨진다. pk를 할당 전에 지정한 경우(`Product(sku="foo")`)는 정상 동작한다. problem_statement에 완전한 재현 스니펫(`with transaction.atomic(): ...`)과 두 assert가 포함되어 있고, hints_text가 결함 함수와 패치 라인까지 직접 지목한다.

## 유형 (정형화)

- **L = L0 (Pinpointed)**: hints_text가 `_prepare_related_fields_for_save()`를 명시하고 `getattr(self, field.attname) is None` 라인을 그대로 인용한다. problem_statement도 "how the Order.product_id field is handled at assignment ... fetching of auto vs non-auto primary keys from the related instance"로 저장 경로를 가리킨다. grep 한 방으로 단일 함수에 도달. cross-file 추적 불필요.
- **S = S2 (Constraint-Reasoning)**: 고칠 지점은 알지만, 올바른 *빈 값 판정 술어*를 추론으로 합성해야 한다. `is None`이 numeric/`AutoField` pk(미설정 시 None)만 빈 값으로 보고 `CharField` pk(미설정 시 "")를 놓친다는 비대칭을 이해하고, "아직 채워지지 않음"의 올바른 불변식이 무엇인지를 따져야 한다. 후보 패치를 마구 던져 테스트로 거르는 G&V(S3/S4)가 아니라, "어떤 값들이 unfilled-pk인가"라는 도메인 불변식을 정확히 짚어 `field.empty_values` 재사용으로 합성하는 것이 본질 — 전형적 SemFix/Angelix류 의미추론.
- **K = K-Domain (Domain-bound)**: 정석 픽스는 django `Field.empty_values`(`[None, '', [], (), {}]`)라는 ORM 내부 속성의 존재와 의미를 알아야 한다. 이걸 모르면 `== ''` 하드코딩 같은 좁은 임시방편으로 빠진다. AutoField vs CharField pk 초기값 차이, FK fk_val 재동기화 시점 등 ORM 저장 라이프사이클 지식이 병목.

**primary type = T-ConstraintReason**: 위치는 명확(L0)하나 픽스가 자명한 가드 추가/상수 변경(S1)이 아니라, 빈 값 판정 술어를 올바르게 일반화(`is None` → `in field.empty_values`)하는 의미 추론이 핵심이다. APR 관점에서 이는 결함 위치는 고정된 채 angelic 조건식을 합성하는 S2 문제이며, 그 술어가 django의 기존 `empty_values` 계약과 정확히 일치해야 K-Domain 정답이 된다.

## 난이도 티어
**Tier = T3 (중간).** 공식 라벨은 "15 min - 1 hour"로, 단일 파일 1줄 변경이라는 patch scope만 보면 T2처럼 보인다. T3로 올리는 구조적 피처는:
- **localize는 trivial(L0)**이고 **has-repro**(재현 스니펫 + 강한 easiness 신호)라 아래로 당기지만,
- 픽스가 **S2 의미추론 + K-Domain**이라는 점이 위로 민다. `is None`을 보고 "그냥 `or == ''`를 붙이자"는 좁은 패치는 빈 list/tuple/dict pk를 놓쳐 부분정답에 그치며, 정답은 `field.empty_values` 재사용을 *알아야* 나온다. 즉 1줄이지만 "올바른 일반화"의 폭이 정답률을 가른다.
- **regression-trap(P2P 36개)**: `_prepare_related_fields_for_save`는 모든 FK 저장 경로가 거치는 hot path라, 빈 값 판정을 넓히면서 정상적으로 채워진 pk(예: `0`, falsy지만 valid한 정수 pk는 아니지만 — `0`은 `empty_values`에 없음)나 nullable FK 저장을 깨면 안 된다.

공식 difficulty(15분-1시간)와 본 tier(T3)는 사실상 정합적이다. 시간라벨은 "개발자 구현시간"이고, L0+has-repro 덕에 에이전트 localize는 쉽지만 정답 일반화에 K-Domain이 필요하다는 점이 T3를 정당화한다. T2로 내리지 않은 이유는 픽스가 기계적 S1이 아니기 때문.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/base.py` : `Model._prepare_related_fields_for_save` (line 936 부근).
- **근본 원인**: 부모(related object)를 자식 할당 *이후에* 저장한 경우, 자식 저장 시 `field.attname`(예: `product_id`)을 부모의 `obj.pk`로 재동기화하는 분기가 있다. 그 진입 조건이 `getattr(self, field.attname) is None`이었다. `AutoField`/numeric pk는 미설정 시 `None`이라 이 조건을 통과해 재동기화되지만, `CharField` pk는 미설정 시 빈 문자열 `""`이라 `is None`을 통과하지 못한다. 결과적으로 `product_id`가 ""로 남아 그대로 저장되고, deferred FK 제약이 커밋 시 위반된다.
- **수정 요지**: 단 한 줄. `elif getattr(self, field.attname) is None:` → `elif getattr(self, field.attname) in field.empty_values:`. `empty_values`는 `[None, '', [], (), {}]`를 포함하므로 빈 문자열 pk(및 빈 컬렉션 pk)도 "아직 안 채워짐"으로 인식되어, 부모 저장 후의 `obj.pk`로 `setattr(self, field.attname, obj.pk)`가 실행된다. None만 보던 좁은 술어를 django의 기존 empty 계약으로 일반화한 것.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_save_fk_after_parent_with_non_numeric_pk_set_on_child (many_to_one.tests.ManyToOneTests)`. 문자열 pk 부모를 자식에 할당 → 늦게 pk를 채움 → `parent.save()` → `child.save()` → `refresh_from_db()` 후 `child.parent == parent` 및 `child.parent_id == parent.name`('jeff')을 검증.
- **테스트 모델 신설**: `tests/many_to_one/models.py`에 `ParentStringPrimaryKey(name=CharField(primary_key=True, max_length=15))`와 이를 `on_delete=CASCADE`로 받는 `ChildStringPrimaryKeyParent` 추가, `tests.py` import 라인 갱신.
- **픽스 증명**: 픽스 전에는 `child.parent_id`가 ""로 저장되어 `refresh_from_db` 후 `child.parent_id == 'jeff'` assert가 실패(혹은 FK 위반). 픽스 후 `""`가 `empty_values`에 매칭되어 `obj.pk`('jeff')로 재동기화되므로 통과.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇긴 하나, 픽스가 `field.empty_values`라는 일반 술어를 쓰므로 string pk라는 특정 케이스에 over-tune된 게 아니라 모든 empty pk 타입으로 일반화된다(S4 CEGIS 함정 회피). `== ''` 하드코딩이었다면 overfit-risk가 컸을 것.
- **regression 관점**: P2P 36개가 `test_save_nullable_fk_after_parent`, `test_save_nullable_fk_after_parent_with_to_field`, `test_assign_fk_id_none`, `test_fk_to_bigautofield/smallautofield`, "Model.save() invalidates stale ForeignKey relations after a primary key" 등 동일 저장 경로의 인접 동작을 광범위하게 커버. `is None` → `in empty_values`로 술어를 넓혔어도 valid한 pk(예: 정수 `0`은 `empty_values`에 없음, 정상 pk 문자열은 비어있지 않음)는 여전히 재동기화 분기를 타지 않으므로 이 36개가 안 깨짐을 보장.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement의 "Order.product_id ... at assignment ... auto vs non-auto primary keys"와 hints_text의 `_prepare_related_fields_for_save()` 지목을 따라 `django/db/models/base.py`의 해당 메서드로 직행. `save()` → `_prepare_related_fields_for_save` → unsaved-related 가드 다음의 pk 재동기화 `elif` 분기를 읽는다. has-repro라 `transaction.atomic()` 스니펫으로 즉시 재현 가능.

2. **픽스와 올바른 일반화**: 핵심 통찰은 "numeric은 되고 string은 안 되는" 비대칭이 빈 값 판정 술어 `is None`에 있다는 것. `AutoField`는 unset=`None`, `CharField`는 unset=`""`. 올바른 일반화는 임시 `or == ''`가 아니라 django가 이미 정의한 `field.empty_values`(`[None, '', [], (), {}]`)를 재사용하는 것 — 이래야 빈 컬렉션 pk 등 모든 unfilled-pk 형태를 한 술어로 덮고, "비어있음"의 의미를 프레임워크 계약과 일치시킨다. overfit이 아닌 이유: 특정 입력이 아니라 결함의 원인 클래스(empty-pk 판정) 자체를 고친다.

3. **regression 안전**: 변경은 단 한 분기의 진입 조건을 *넓히는* 방향이라, 안 깨야 할 P2P는 (a) valid pk가 이미 채워진 경우(비어있지 않으므로 분기 미진입 → 기존 값 보존), (b) nullable FK가 의도적으로 None인 경우(`test_assign_fk_id_none`, `test_save_nullable_fk_after_parent*`). `0` 같은 falsy-but-valid 정수 pk는 `empty_values`에 없어 안전. 36개 P2P가 이 경로의 정상 동작을 가드하므로 술어 확장이 부작용 없음을 회귀로 확인.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (1) 증상(빈 문자열 저장)을 보고 `ForwardManyToOneDescriptor`의 할당 시점 캐싱이나 디스크립터를 건드리려 헤맴(잘못된 localize). 실제 결함은 저장 시 재동기화 술어 하나. (2) `== ''` 또는 `in (None, '')` 같은 좁은 하드코딩으로 빈 list/tuple pk를 놓침 — `field.empty_values` 존재를 모르면 부분정답에 그침. 회피법: 같은 함수 내 다른 빈 값 처리나 `Field` 베이스 클래스를 grep해 `empty_values`라는 기존 SSOT 속성을 발견하고 재사용하는 것이 SOTA 픽스와 임시방편을 가른다.
