---
instance_id: django__django-13033
repo: django/django
base_commit: a59de6e89e8dc1f3e71c9a5a5bbceb373ea5247e
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-06-07T14:52:19Z
fail_to_pass: 1
pass_to_pass: 26
gold_files: [django/db/models/sql/compiler.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13033

## 문제 요약
자기참조(self-referential) ForeignKey를 따라 `order_by("record__root_id")`처럼 `_id` 컬럼으로 정렬하면, ORM이 명시한 정렬을 무시하고 대상 모델의 `Meta.ordering` 기본 정렬을 끼워 넣는다. 그 결과 불필요한 추가 JOIN(`LEFT OUTER JOIN ... T3`)이 생기고, 정렬 방향이 `OneModel.Meta.ordering = ("-id",)`를 따라 예상과 반대(DESC)로 나온다. 사용자는 `_id` 필드로 명시 정렬했으니 단일 INNER JOIN에 `ORDER BY ... root_id ASC`를 기대했다. 비-self FK에서는 같은 경로가 정상 동작하기 때문에 self-참조라는 특정 조건에서만 드러나는 silent-wrong 결함이다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: 이슈가 `compiler.py`/`find_ordering_name`을 직접 지목하진 않지만, "default sort order on the OneModel class" + "unnecessary extra join" + `record__root_id` vs `record__root__id`의 SQL 대비라는 강한 키워드 신호가 ordering이 relation default를 append하는 단일 분기로 빠르게 수렴시킨다. 게다가 hints_text에 골드와 거의 동일한 후보 diff(`!= name` → `!= pieces[-1]`)가 이미 제시되어 있어 탐색 비용이 낮다. grep "한 방"(L0)은 아니고 "ordering"/"default ordering" 키워드 추적이 필요하므로 L1.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점(`find_ordering_name`의 4-항 조건문)은 명확하지만, 올바른 픽스는 후보 난사(S3)나 테스트 반복 수렴이 아니라 "`name`은 점경로 전체(`record__root_id`)인데 `field.attname`은 마지막 조각(`root_id`)"이라는 **불변식의 어긋남을 추론으로 짚어** 비교 피연산자를 `name`→`pieces[-1]`로 합성하는 일이다. 정형 결함클래스(None-guard/off-by-one)의 템플릿 매칭(S1)이 아니라, 점-경로 분해 의미론을 따져 올바른 비교식을 도출하는 SemFix/Angelix류의 의미적 수리라 S2가 dominant.
- **K (Knowledge) = K-Domain**: `find_ordering_name`, `pieces`(LOOKUP_SEP split 결과), `field.attname`, `opts.ordering`, relation-default-ordering append 규칙은 django ORM SQL 컴파일러 내부 지식이다. 일반 파이썬 추론(K-Gen)으로는 "왜 self FK에서만 `attname != name`이 항상 참이 되는가"를 설명할 수 없고, query-compiler 도메인 모델을 알아야 한다.
- **Primary type = T-ConstraintReason**: 위치는 비교적 명확(L1)하나 진짜 난점이 "올바른 비교식을 의미 추론으로 합성"(S2)하는 데 있다. T-DirectMap이 아닌 이유는 픽스가 가드 추가/기본값 변경 같은 기계적 템플릿이 아니라 경로-분해 의미론에 대한 추론이기 때문이고, T-DomainBound로 보지 않는 이유는 도메인 지식이 병목이라기보다 그 지식 위에서의 **조건식 추론**이 핵심 작업이기 때문이다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(prior로 T2~T3급)인데, 다음 구조적 피처가 T4로 끌어올린다:
- **단일 파일·1 헌크·실질 5줄**: patch scope 자체는 작아(파일수·줄수만 보면 T2) 하방 압력이 있다.
- **S2 constraint 추론 + K-Domain**: 루브릭상 "constraint추론·소규모 refactor·도메인지식 중 하나 + L1/L2"가 T4의 전형 프로파일이다. `name` vs `pieces[-1]`의 차이를 ORM 점-경로 의미론으로 추론해야 하는 점이 단순 시간라벨에 안 잡히는 난이도.
- **regression-trap (P2P 26개)**: ordering 분기는 모든 relation 정렬·default ordering 경로가 공유하므로, `pieces[-1]`로 바꾸면 `test_order_by_fk_attname`/`test_default_ordering`/`test_related_ordering_duplicate_table_reference` 등 인접 26개를 깨선 안 된다. 넓은 P2P trap은 루브릭에서 명시적으로 T4를 미는 신호다.
- **has-repro(↓)는 있지만**: 이슈에 SQL 레벨 reproducer가 있어 easiness 신호이긴 하나, 그게 곧 픽스 위치를 주는 건 아니고(테스트는 SQL이 아니라 queryset 결과 비교) 재현 모델이 self FK여야만 한다는 함정이 상쇄한다.

순효과: scope는 작지만 의미 추론 + 광범위 regression surface로 T3을 넘어 T4. T5는 아니다 — 멀티파일/멀티헌크 조율(L3/S6)도, overfit 고위험(S4)도 없기 때문.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/sql/compiler.py` 의 `find_ordering_name` (라인 ~727 조건문).
- **근본 원인**: relation 필드의 default ordering을 append할지 판단하는 조건
  `if field.is_relation and opts.ordering and getattr(field, 'attname', None) != name and name != 'pk':`
  에서 `name`은 점경로 전체(`record__root_id`)인 반면 `field.attname`은 그 경로의 마지막 조각(`root_id`)이다. 따라서 `attname != name`은 다중-홉 경로에서 거의 항상 참이 되어 "사용자가 `_id` attname을 직접 지정한 게 아니다"로 **오판**, default ordering append 분기로 진입한다. 일반 FK에서는 join 구조상 우연히 증상이 가려졌지만 self-referential FK 경로에서는 그대로 노출되어, 여분의 `LEFT OUTER JOIN T3`와 `Meta.ordering`을 따르는 역방향 정렬을 만든다.
- **수정 요지**: 비교 피연산자를 전체 `name`이 아니라 경로의 마지막 조각 `pieces[-1]`로 교체.
  `getattr(field, 'attname', None) != pieces[-1]`. 이러면 `record__root_id`의 마지막 조각 `root_id`가 `field.attname`(`root_id`)과 일치 → "attname을 직접 지정함"으로 올바르게 인식하여 default ordering append를 건너뛰고, 단일 JOIN에서 명시한 `_id` 컬럼으로 정렬한다. 골드는 이 한 줄을 가독성 위해 다중-줄 괄호 조건으로 포맷팅만 추가했고 의미 변경은 `name`→`pieces[-1]` 하나뿐이다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_order_by_self_referential_fk (ordering.tests.OrderingTests)`. 픽스 트리거를 위해 `tests/ordering/models.py`의 `Author`에 self FK `editor = models.ForeignKey('self', models.CASCADE, null=True)`를 추가한다(`Author.Meta.ordering = ('-pk',)` 기존 보유).
- **픽스 증명**: 테스트는 두 케이스를 **대비**시킨다.
  - `order_by('author__editor')` — relation 자체로 정렬이므로 대상 모델 default ordering(`('-pk',)`)을 따라야 정상 → 기대값 `['Article 2', 'Article 1']`(역순). 이 경로는 픽스 전후 모두 default ordering을 적용해야 하며, 픽스가 이걸 망가뜨리지 않음을 보장.
  - `order_by('author__editor_id')` — `_id` attname 직접 정렬이므로 default ordering으로 새면 안 됨 → 기대값 `['Article 1', 'Article 2']`(정순). **픽스 전엔 default `-pk`로 새어 역순이 되어 실패**, 픽스 후 `pieces[-1]=='editor_id'==attname` 일치로 단순 `_id` 정렬이 되어 통과.
- **overfit 관점**: 단일 FAIL_TO_PASS이지만 두 정렬 경로(relation vs `_id`)를 한 테스트에서 paired로 검증하므로, "self FK일 때만 무조건 default를 끈다" 같은 special-case 패치는 첫 케이스(`author__editor`가 여전히 `-pk`를 적용해야 함)에서 깨진다. 즉 테스트가 일반화를 어느 정도 강제하므로 overfit-risk는 낮음(플래그 미부여).
- **regression 관점**: P2P 26개가 ordering 서브시스템 전반(fk_attname/default_ordering/extra_ordering/reverse_meta_ordering/related_ordering_duplicate_table_reference 등)을 커버. `pieces[-1]` 교체는 hints_text의 "전 테스트 스위트 스캔에서 이 분기 변화가 reproducer에서만 트리거됨" 검증대로 다른 경로의 동작을 바꾸지 않아야 하며, 26개 P2P가 그 안전망이다 → regression-trap 플래그.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 핵심 신호 세 가지 — (a) "default sort order on the OneModel class"가 끼어든다, (b) "unnecessary extra join", (c) `record__root_id`/`record__root`는 버그, `record__root__id`/`annotate`는 정상 — 를 종합하면 "relation 필드에 도달했을 때 default ordering을 append할지 결정하는 분기"가 범인이다. `compiler.py`에서 "append the default ordering for that model unless it is the pk shortcut or the attribute name of the field that is specified"라는 주석이 달린 `find_ordering_name`의 단일 조건문으로 수렴. (hints_text의 후보 diff가 있으면 즉시, 없어도 ordering 키워드로 L1 추적 가능.)
2. **픽스와 올바른 일반화**: 조건의 `getattr(field, 'attname', None) != name`에서 타입 불일치를 인지 — `name`은 split 전 전체 경로, `attname`은 단일 컬럼명. 함수는 이미 `pieces = name.split(LOOKUP_SEP)`로 경로를 분해해 들고 있으므로, "사용자가 명시한 마지막 토큰이 이 필드의 attname인가?"라는 **의도된 의미**를 정확히 표현하려면 `pieces[-1]`과 비교해야 한다. 이는 self FK에만 거는 special-case가 아니라 모든 다중-홉 경로에서 동일하게 옳은 일반화다(single-hop에서는 `name==pieces[-1]`이라 동작 불변).
3. **regression 안전**: 깨지면 안 되는 P2P는 `test_order_by_fk_attname`(`_id` attname 정렬은 default를 안 따라야), `test_default_ordering`/`test_default_ordering_override`(relation 자체 정렬은 default를 따라야), `test_related_ordering_duplicate_table_reference`(중복 join 방지), `test_reverse_meta_ordering_pure`(역방향 meta ordering). 픽스는 `name==pieces[-1]`인 단일-홉 케이스에서 동작을 전혀 바꾸지 않고, 다중-홉에서 attname 직접 지정만 default-append에서 제외하므로 이들 전부 보존된다.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 실수 — (a) `name`이 이미 마지막 토큰이라고 가정해 `pieces[-1]` 교체 필요성을 못 봄(단일-홉 테스트만 보면 차이가 안 드러남), (b) regression이 두려워 "self FK 감지" 같은 과도하게 좁은 조건을 새로 끼워 넣어 첫 paired 케이스를 깸, (c) 증상(여분 JOIN/역방향 정렬)을 join 생성부에서 잡으려다 진짜 원인인 default-ordering append 분기를 놓침. 회피법: 비교 양변의 의미(경로 vs 컬럼명)를 명시적으로 따지고, 이미 존재하는 `pieces` 변수를 재사용하는 최소 변경에 머무르며, hints의 "전 스위트 스캔 시 이 분기 변화가 reproducer에서만 트리거된다"는 scope 검증을 P2P 26개로 대체 확인한다.
