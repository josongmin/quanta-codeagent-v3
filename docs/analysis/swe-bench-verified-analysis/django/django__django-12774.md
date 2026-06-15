---
instance_id: django__django-12774
repo: django/django
base_commit: 67f9d076cfc1858b94f9ed6d1a5ce2327dcc8d0d
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-04-22T11:02:30Z
fail_to_pass: 1
pass_to_pass: 41
gold_files: [django/db/models/query.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-12774

## 문제 요약
`QuerySet.in_bulk(field_name=...)`는 지정 필드가 `unique=True`일 때만 허용한다. 같은 필드를 `Meta.constraints`의 단일 컬럼 `UniqueConstraint`로 유니크하게 만든 경우, 실제로는 유니크함에도 `ValueError("in_bulk()'s field_name must be a unique field but %r isn't.")`를 던지며 거부한다. 이슈는 `slug` 필드를 `UniqueConstraint(fields=["slug"])`로 보장한 모델에서 `in_bulk(field_name="slug")`가 실패하는 traceback과 함께 "고치기 쉽고 패치도 있다"고 명시한다. 즉 정당한 호출인데 잘못된 예외를 내는 over-restrictive validation 버그다.

## 유형 (정형화)
- **L0 (Pinpointed)** — traceback이 `django/db/models/query.py` line 680 `in_bulk`와 에러 메시지 리터럴을 직접 지목한다. 에러 문자열만 grep해도 단일 함수의 단 한 줄 분기(`if field_name != 'pk' and not ...unique:`)로 즉시 수렴. localize 노력 사실상 0.
- **S2 (Constraint-Reasoning) +S5 (Spec-Inference)** — 고칠 지점(그 `if` 조건)은 자명하나, 핵심은 "어떤 제약을 유니크로 인정할지"의 **올바른 술어를 추론으로 합성**하는 것이다. 단순히 "제약이 있으면 통과"가 아니라, (1) 단일 컬럼 제약만(`len(constraint.fields) == 1`), (2) 전체 행 유니크만(partial/conditional 제외) 인정해야 한다는 불변식을 따져야 정확하다. 이 경계는 코드만 보면 결정 안 되고 "row 전체에 대한 유니크 보장"이라는 in_bulk의 암묵 계약(스펙)에서 도출되므로 S5가 보조로 붙는다. G&V로 테스트만 맞추면 partial 케이스를 빠뜨리기 쉬워 S3/S4가 아니라 의미적 추론(S2)이 dominant.
- **K-Domain** — `_meta.total_unique_constraints` 프로퍼티(deferrable/partial 제약을 이미 걸러주는 django 내부 API)의 존재를 알아야 깔끔하게 풀린다. 이를 모르면 `_meta.constraints`를 직접 순회하며 `condition is None` 등을 손으로 짜야 해 과/미달 구현 위험. 프레임워크 ORM meta API 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 난점이 "올바른 조건식을 의미적으로 합성"하는 데 있어 T-DirectMap(기계적 가드)보다 한 단계 위. 단순 None가드/상수변경 템플릿으로 환원되지 않는다.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 1파일 1함수, +11/-1줄 소규모 → scope 자체는 작음(T1~T2 신호).
- `has-repro`(완전한 traceback + 재현 모델) → easiness 강신호.
- 하지만 픽스가 기계적이지 않다: 정확한 픽스는 단일 컬럼 필터 + partial 제외라는 **이중 경계 추론(S2)** 을 요구하고, `total_unique_constraints`라는 **도메인 API 지식(K-Domain)** 에 의존한다.
- `regression-trap`: PASS_TO_PASS 41개 중 `test_in_bulk_non_unique_meta_constaint`가 partial 단일컬럼(`ean`)과 다중컬럼(`brand`,`name`)을 **여전히 거부**하라고 요구 → "통과만 시키면 됨"이 아니라 "정확히 그 범위만"이어야 함.

공식 라벨 `15 min - 1 hour`(개발자 구현시간, T2~T3 prior)와 대체로 일치하나, 시간라벨에 안 잡히는 **경계 추론 + meta-API 지식 + 회귀 트랩**이 T2가 아닌 **T3**으로 민다. T4까지 가지 않는 이유: localize가 L0로 자명하고, 수정이 단일 헌크·단일 파일이며, 추론 깊이가 한 술어 합성 수준이라 cross-module 데이터플로우나 구조 변경이 없기 때문.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/query.py` — `QuerySet.in_bulk(self, id_list=None, *, field_name='pk')`.
- **근본 원인**: 유니크성 검사가 `self.model._meta.get_field(field_name).unique` 한 가지만 본다. 단일 컬럼 `UniqueConstraint`로 부여된 유니크성은 `Field.unique` 속성에 반영되지 않으므로(제약은 `_meta.constraints`에 별도로 존재) 누락되어, 실제 유니크한 필드를 거부한다.
- **수정 요지**: `opts = self.model._meta`를 잡고, `opts.total_unique_constraints`를 순회해 `len(constraint.fields) == 1`인 제약의 `constraint.fields[0]`만 모은 `unique_fields` 리스트를 만든다. 거부 조건을
  `field_name != 'pk' and not opts.get_field(field_name).unique and field_name not in unique_fields`
  로 확장한다. 핵심 선택은 `constraints`가 아니라 `total_unique_constraints`를 쓴 것 — 이 프로퍼티가 conditional(partial) 제약과 deferrable 제약을 이미 제외해 주므로, partial/composite 케이스를 별도 분기 없이 자동으로 걸러낸다. `len == 1` 필터는 다중 컬럼 제약을 추가로 배제한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_in_bulk_meta_constraint` — `Season` 모델에 `UniqueConstraint(fields=['year'], name='season_year_unique')`를 추가하고, `Season.objects.in_bulk([2011, 2012], field_name='year')`가 `{2011: season_2011, 2012: season_2012}`를 반환하는지 확인. 픽스 전: `year`는 `unique=True`가 아니므로 ValueError. 픽스 후: 단일 컬럼 제약 필드가 `unique_fields`에 들어가 통과.
- **픽스 증명 / regression 가드**: PASS_TO_PASS의 `test_in_bulk_non_unique_meta_constaint`(`@isolate_apps`)가 핵심 음성 테스트다 — partial 단일 컬럼 제약(`UniqueConstraint(fields=['ean'], condition=Q(is_active=True))`)과 다중 컬럼 제약(`UniqueConstraint(fields=['brand','name'])`)의 `ean`/`brand`에 대해 **여전히 ValueError**가 나야 한다. `total_unique_constraints`(partial 제외) + `len==1`(composite 제외)이 둘 다 정확히 막는지 검증. 기존 `test_in_bulk`/`test_in_bulk_with_field`/`test_in_bulk_non_unique_field`도 회귀 가드로 동작.
- **overfit·regression 관점**: FAIL_TO_PASS가 1개로 얇아 G&V식으로 "제약 있으면 통과"만 구현하면 FAIL_TO_PASS는 녹색이 되지만 `test_in_bulk_non_unique_meta_constaint`가 즉시 깨진다. 즉 음성 테스트가 overfit을 차단하는 구조라, 정답은 partial/composite 경계를 정확히 추론한 패치뿐. 회귀면은 단일 함수 내 보수적 확장이라 인접 동작 영향은 좁다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 traceback이 `django/db/models/query.py` 680행과 에러 메시지 `"in_bulk()'s field_name must be a unique field..."`를 직접 준다. 이 리터럴을 grep → `in_bulk`의 단일 분기 `if field_name != 'pk' and not self.model._meta.get_field(field_name).unique:`에 즉시 도달. L0.
2. **픽스와 올바른 일반화 이유**: 거부 조건에 "단일 컬럼 `UniqueConstraint`로 유니크한 필드"를 예외로 추가한다. 일반화의 정당성은 in_bulk의 의미적 계약 — `field_name`이 **각 행을 유일하게 식별**해야 dict 키로 안전하다 — 에서 온다. 따라서 (a) 전체 행에 대한 유니크만 인정(=`total_unique_constraints`로 partial/conditional 제외), (b) 단일 컬럼만 인정(`len==1`, 다중 컬럼은 단일 `field_name`을 유일화하지 않음). 이 두 경계가 곧 overfit이 아닌 올바른 일반화이며, `total_unique_constraints` 프로퍼티 재사용이 partial 처리를 직접 짜는 것보다 정확하고 미래 제약 종류에도 강건하다.
3. **regression 안전**: 기존 `unique=True` 경로(`not opts.get_field(field_name).unique`)와 `pk` 경로는 손대지 않고 `or`-확장만 했으므로 기존 `test_in_bulk*` 전부 보존. 반드시 안 깨야 할 P2P는 `test_in_bulk_non_unique_field`(평범한 비유니크 필드 거부)와 신규 음성 `test_in_bulk_non_unique_meta_constaint`(partial `ean`·composite `brand` 거부) — 둘 다 거부 동작이 유지돼야 한다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (i) `_meta.constraints`를 직접 순회하며 `UniqueConstraint`면 무조건 인정 → partial(`condition`) 케이스 회귀로 음성 테스트 깨짐. 회피: `total_unique_constraints` 사용(partial/deferrable 자동 제외). (ii) `len(constraint.fields) == 1` 필터 누락 → 다중 컬럼 제약의 첫 필드를 잘못 유니크로 인정. 회피: 단일 컬럼만 모으기. (iii) `unique_together`로 착각 → 의미·자료구조가 다름. 정답은 deferrable/partial을 이미 정리해주는 `total_unique_constraints` 프로퍼티의 존재를 아는 것(K-Domain)이며, 이를 모르면 과/미달 구현이 되어 41개 P2P 중 음성 테스트에서 걸린다.
