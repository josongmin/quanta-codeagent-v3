---
instance_id: django__django-13417
repo: django/django
base_commit: 71ae1ab0123582cc5bfe0f7d5f4cc19a9412f396
version: 3.2
difficulty: <15 min fix
created_at: 2020-09-14T07:49:15Z
fail_to_pass: 2
pass_to_pass: 280
gold_files: [django/db/models/query.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13417

## 문제 요약
`Meta.ordering`이 정의된 모델에서 `annotate(Count(...))`처럼 GROUP BY를 유발하는 쿼리를 만들면, 실제 생성되는 SQL에 ORDER BY 절이 없는데도 `QuerySet.ordered` 프로퍼티가 여전히 `True`를 반환한다. 사용자는 결과가 정렬되지 않으므로 `ordered`가 `False`이기를 기대했다. Django는 커밋 `0ddb4ebf` 이후 `Meta.ordering`이 GROUP BY 쿼리에 영향을 주지 않도록(deprecation은 `1b1f64ee`) 바꿨는데, `ordered` 프로퍼티가 그 변경을 반영하지 못해 정렬 상태를 거짓 보고하는 버그다. 이슈 본문에 실제 SQL 출력과 `qs.ordered`/`qs.query.default_ordering` 값까지 포함된 명확한 재현 예시가 있다.

## 유형 (정형화)
- **L (Localization) = L0** — 이슈 본문이 `QuerySet.ordered` 프로퍼티와 `query.default_ordering`을 직접 호명하고, hints가 "We should adjust QuerySet.ordered"라고 픽스 대상을 명시. `django/db/models/query.py`의 `ordered` 프로퍼티가 grep 한 방으로 잡히는 핀포인트.
- **S (Repair Strategy) = S1 (+S2)** — dominant는 S1(Direct-Map). 픽스가 사실상 정형 결함클래스(누락 case 가드 추가)에 템플릿 매칭되고, 기존 `elif` 조건식에 합취(AND) 조건 한 개를 더하는 기계적 수정. 보조로 S2(Constraint-Reasoning): "왜 group_by일 때 `Meta.ordering`이 무시되는가"라는 불변식을 0ddb4ebf 히스토리에서 추론해 `not self.query.group_by`라는 올바른 술어를 합성해야 한다. 그럼에도 일단 인과를 이해하면 픽스 형태는 결정적이라 S1이 dominant.
- **K (Knowledge) = K-Domain** — 일반 파이썬 추론만으로는 부족. `query.group_by`가 GROUP BY 유무를 나타내고 그것이 `Meta.ordering`의 SQL 반영을 무력화한다는 django ORM/query-compiler 내부 지식이 병목. 공개 API 계약(시그니처/리턴형) 문제는 아니므로 K-API 아님.
- **primary type = T-DirectMap** — 위치가 L0로 자명하고, 픽스가 S1 기계적 가드 추가(누락 case 처리)이므로 루브릭상 "위치 명확 + S1 기계적 픽스"인 T-DirectMap에 정확히 대응. L0+S1 순수 자명이면 T-LocTrivial이겠으나, 올바른 술어 합성에 도메인 추론(S2/K-Domain)이 끼어 자명도가 떨어지므로 T-DirectMap이 맞다.

## 난이도 티어
**Tier = T3 (중간).** 공식 라벨은 `<15 min fix`(T1~T2 prior)지만 한 단계 올린다.
- **올리는 피처**: (1) **regression-trap** — PASS_TO_PASS가 280개로 매우 넓고, 그중 `test_annotated_ordering`, `test_explicit_ordering`, `test_order_by_extra` 등 정렬 관련 인접 동작이 다수라 가드를 잘못된 위치(예: `extra_order_by`/`order_by` 분기, 또는 `default_ordering` 자체 비활성화)에 넣으면 즉시 회귀. 변경 범위를 default-ordering `elif` 가지로 정확히 한정해야 한다. (2) **K-Domain 추론** — `group_by` truthiness가 GROUP BY를 나타낸다는 인과를 SQL 차원에서 재구성해야 하며, compiler를 파고드는 과수정(overreach)로 빠지기 쉬움.
- **내리는(완화) 피처**: 단일 파일·1헌크·실질 1줄, **has-repro**(이슈에 SQL+값 재현 포함, easiness 강신호), L0 핀포인트. 그래서 T4까지는 안 가고 T3에 안착.
- **공식 라벨과의 차이**: 개발자 구현시간은 짧지만(픽스 형태가 작음), 에이전트 관점에서는 280개 P2P trap과 "최소 가드 위치 판단"이 시간라벨에 안 잡히는 실패 위험이라 T3로 재조정.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/query.py` — `QuerySet.ordered` 프로퍼티 (약 1224행).
- **근본 원인**: `ordered`의 분기가 `self.query.default_ordering and self.query.get_meta().ordering`만 검사했다. `annotate`로 GROUP BY가 걸리면 `Meta.ordering`은 0ddb4ebf 이후 SQL에 반영되지 않으므로, 이 조건이 참이어도 실제 쿼리에는 ORDER BY가 생성되지 않는다 → `ordered`가 거짓 양성(`True`).
- **수정 요지**: 해당 `elif` 조건에 `and not self.query.group_by`를 추가해 3항 합취로 만든다. 즉 default ordering과 `Meta.ordering`이 있어도 `query.group_by`가 설정돼 있으면 `ordered`를 `True`로 보지 않는다. 앞선 `extra_order_by`/`order_by` 분기는 그대로라, 사용자가 명시적으로 정렬을 걸면 GROUP BY가 있어도 여전히 `True`. 주석 `# A default ordering doesn't affect GROUP BY queries.`로 의도를 박아 회귀를 예방.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_annotated_default_ordering`, `test_annotated_values_default_ordering` (둘 다 `queries.tests.QuerysetOrderedTests`).
- **픽스 증명**: `Tag`는 `Meta.ordering`을 가진 모델. `Tag.objects.annotate(num_notes=Count('pk'))` (및 `.values('name').annotate(...)`)로 GROUP BY 쿼리를 만든 뒤 `qs.ordered`가 `False`임을 단언한다(픽스 전엔 `True`라 실패). 이어 `.order_by('name')`을 추가하면 `ordered`가 `True`가 되는지도 확인 → group_by 가드가 명시적 ordering 경로까지 망가뜨리지 않았음(분기 우선순위 보존)을 보장.
- **overfit 관점**: FAIL_TO_PASS는 2개로 얇지만, 두 케이스가 `annotate` 직접/`values().annotate()` 두 경로를 커버하고 각각 명시적 order_by 양성 확인까지 묶어 special-case 통과를 막는다. 픽스가 `not self.query.group_by`라는 일반 술어라 두 테스트 너머 GROUP BY 전반에 일반화됨(overfit 낮음).
- **regression 관점**: P2P 280개 중 `QuerysetOrderedTests`의 `test_annotated_ordering`/`test_cleared_default_ordering`/`test_empty_queryset`/`test_explicit_ordering`/`test_no_default_or_explicit_ordering`/`test_order_by_extra`와 `Queries5Tests.test_ordering` 등이 정렬 상태 불변식을 지킨다. 가드를 default-ordering 가지에만 추가했으므로 이들이 그대로 통과 → 변경의 국소성이 회귀 안전을 보장.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `QuerySet.ordered`와 `query.default_ordering`을 명시하고 hints가 "adjust QuerySet.ordered"라고 못박음 → `django/db/models/query.py`에서 `def ordered`(`@property`) 프로퍼티로 직행. SQL 생성(`sql/compiler.py`)을 파고들 필요 없이 프로퍼티의 조건식만 본다.
2. **픽스(올바른 일반화인 이유)**: 거짓 양성의 원인은 default-ordering 분기가 GROUP BY를 무시한다는 점. `Meta.ordering`이 GROUP BY 쿼리에 영향을 안 준다는 도메인 사실(0ddb4ebf)을 술어로 옮기면 `and not self.query.group_by`. 이는 특정 모델/특정 annotate가 아니라 "GROUP BY가 걸린 모든 default-ordering 쿼리"에 적용되는 일반 가드라 overfit이 아니다. `group_by`가 빈 리스트/`None`/필드 리스트 등 다양한 truthy/falsy 값을 가질 수 있어 `not ...`로 truthiness 검사하는 것이 정확.
3. **regression 안전**: 가드를 `default_ordering` `elif` 가지에만 넣어, 앞선 `if self.query.extra_order_by or self.query.order_by` 분기(명시적 정렬)는 보존. 그래야 GROUP BY + 명시적 `order_by` 조합은 여전히 `True`로 남고 `test_annotated_ordering`·`test_explicit_ordering`·`test_order_by_extra` 등 280개 P2P가 안 깨진다. `default_ordering` 자체를 끄거나 compiler를 손대면 광범위 회귀.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) `ordered`가 왜 틀린지를 SQL 차원에서 인과 재구성하다가 `sql/compiler.py`의 ORDER BY 생성 로직까지 과수정(overreach), (b) `default_ordering`을 비활성화해 명시적 정렬 케이스까지 깨뜨림, (c) 가드를 앞쪽 `if` 분기에 넣어 우선순위를 무너뜨림. 회피법: 픽스를 **default-ordering `elif` 가지에 합취 한 개 추가**로 최소화하고, GROUP BY+명시 order_by 양성 케이스를 머릿속 회귀 체크로 통과시키는지 확인.
