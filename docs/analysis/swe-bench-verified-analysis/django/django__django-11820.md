---
instance_id: django__django-11820
repo: django/django
base_commit: c2678e49759e5c4c329bff0eeca2886267005d21
version: 3.1
difficulty: <15 min fix
created_at: 2019-09-26T08:37:14Z
fail_to_pass: 2
pass_to_pass: 61
gold_files: [django/db/models/base.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-11820

## 문제 요약
`Meta.ordering`에 관계 필드를 따라가는 `__pk` lookup(예: `option__pk`, `parent__pk`)을 넣으면 시스템 체크가 잘못된 `models.E015`("'ordering' refers to the nonexistent field, related field, or lookup ...")를 발생시킨다. `pk`는 모델의 primary key 별칭으로 정상 lookup인데도 `_check_ordering`이 이를 거부한다. 사용자는 `parent__pk` 같은 ordering이 에러 없이 통과되길 기대한다. problem_statement에 회귀 도입 커밋(`440505cb2cadbe1a5b9fba246bcde6c04f51d07e`)이 명시된, 명백한 false-positive 회귀다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)** — problem_statement이 정확한 에러 코드 `models.E015`와 회귀 커밋 해시를 둘 다 지목한다. E015는 코드베이스에서 `Model._check_ordering`이 유일하게 추가하므로 `'ordering' refers to` 또는 `E015` grep 한 방으로 `django/db/models/base.py`의 단일 메서드에 도달한다. `git blame`/회귀 커밋 diff로 변경된 루프까지 즉시 특정 가능. 탐색 비용 사실상 0.

- **S (Repair Strategy) = S2 (Constraint-Reasoning)** — 고칠 *지점*은 자명하지만(L0), *올바른 조건식*은 추론으로 합성해야 한다. 단순 가드 추가(S1)로 끝나지 않는 이유: (a) `pk`가 `get_field`로 안 잡히는 별칭이라는 ORM 불변식을 알고 `_cls._meta.pk`로 우회해야 하고, (b) "비관계 필드 뒤에 또 part가 이어지면 그건 잘못된 lookup"이라는 엣지케이스 불변식을 따져 `_cls = None`으로 컨텍스트를 끊어야 한다. 둘 다 "여러 후보를 테스트로 돌려보며 수렴"하는 G&V(S3/S4)가 아니라, lookup 분해 루프의 상태기계를 머리로 따져 정확한 분기를 써넣는 의미적 추론이다. SemFix/Angelix 계열의 조건 합성에 해당.

- **K (Knowledge) = K-Domain** — django ORM 내부 지식이 병목이다. `pk`가 실제 필드가 아니라 `_meta.pk` 별칭이라는 것, `fld.is_relation`/`get_path_info()[-1].to_opts.model`로 관계를 따라 모델 컨텍스트(`_cls`)가 전진한다는 것, lookup transform(`get_transform`) 처리 경로 — 모두 프레임워크 model `_meta` API에 대한 도메인 지식. 일반 파이썬 추론으로는 도달 불가.

- **Primary Type = T-ConstraintReason** — L0로 위치는 명확하나, 픽스가 기계적 템플릿(None가드/상수변경)이 아니라 S2 조건 합성이고 그게 핵심 난점이다. K-Domain이 강하게 받쳐주지만 dominant 병목은 "두 불변식을 동시에 만족하는 정확한 분기 작성"이라는 추론이므로 T-DomainBound보다 T-ConstraintReason이 더 정확하다.

## 난이도 티어

**Tier = T4 (약간 어려움)**. 공식 라벨은 `<15 min fix`(가장 쉬움)이지만 에이전트 관점에서 한 단계 올린다.

- 티어를 올리는 구조적 피처:
  - **양방향 제약(P2P trap)**: 단순히 pk를 통과시키는 게 아니라, 비관계 필드 뒤 체이닝(`parent__field1__field2`)에 대해 *여전히* E015를 내야 한다. `else: _cls = None` 한 줄을 빠뜨리면 신규 테스트 `test_ordering_pointing_multiple_times_to_model_fields`가 깨지고, 인접 P2P(`test_ordering_pointing_to_two_related_model_field`)까지 위험. 즉 "절반만 맞는 패치"가 매우 자연스럽게 나온다 — 이게 시간라벨에 안 잡히는 난점.
  - **regression-trap (P2P=61)**: `_check_ordering` 분기를 건드리면 ordering 관련 인접 체크(누락 필드/비관계 필드/등록 lookup/2단계 관계) 다수를 동시에 안 깨야 한다.
  - **K-Domain**: pk 별칭·`_meta` API 지식이 없으면 `_cls._meta.pk` 우회 자체를 못 떠올린다.
- 티어를 내리는 피처: L0(grep 한 방), 단일 파일·헌크 1개·실질 +6줄, has-repro(회귀 커밋+에러코드 명시) → T5/T6는 아님.
- 공식 라벨과의 차이: 개발자 *구현시간*은 짧다(픽스 6줄). 그러나 에이전트 난이도를 끌어올리는 건 localize가 아니라 **두 번째 불변식(`_cls=None`)을 놓칠 overfit/regression 위험**이며, 이는 시간라벨(<15분)이 포착하지 못하는 축이다. 그래서 T2가 아니라 T4.

## 골드패치 분석

- **건드린 파일·함수**: `django/db/models/base.py` → `Model._check_ordering` (classmethod), ordering 문자열을 `LOOKUP_SEP`(`__`)로 분해해 part마다 필드를 해석하는 루프.
- **근본 원인**:
  1. 루프가 각 part에 대해 무조건 `fld = _cls._meta.get_field(part)`를 호출하는데, `pk`는 실제 필드명이 아니라 primary key 별칭이라 `get_field('pk')`가 `FieldDoesNotExist`를 던진다 → except 절에서 transform도 아니므로 false-positive E015 추가.
  2. 관계가 아닌 필드를 해석한 뒤에도 `_cls`가 직전 관계 모델로 남아 있어, `parent__field1__field2`처럼 비관계 필드 뒤에 part가 더 붙으면 잘못된 모델 컨텍스트에서 해석이 이어진다(원래 정당한 에러가 마스킹될 수 있음).
- **수정 요지**:
  - part가 `'pk'`이면 `get_field` 대신 `fld = _cls._meta.pk`를 직접 사용하는 분기 추가 → pk 별칭을 정상 해석.
  - 해석된 `fld`가 `is_relation`이 아니면 `else: _cls = None`으로 컨텍스트를 끊음 → 비관계 필드 뒤에 또 part가 오면 다음 반복에서 `None._meta...`가 `AttributeError`로 떨어져 정당한 E015가 유지된다.

## 검증 (test_patch)

- **FAIL_TO_PASS (정확히 2개)**:
  - `test_ordering_pointing_to_related_model_pk` — `Child.Meta.ordering = ('parent__pk',)` 모델의 `Child.check()`가 빈 리스트 `[]`를 반환해야 한다(가짜 E015 제거). pk 별칭 분기를 증명.
  - `test_ordering_pointing_multiple_times_to_model_fields` — `ordering = ('parent__field1__field2',)`(비관계 `field1` 뒤 part 추가)는 *여전히* `E015`를 내야 한다. `_cls = None` 끊기 로직을 증명.
- **픽스 증명(양방향)**: 한 테스트는 false-positive 제거(정상은 통과), 다른 테스트는 true-positive 유지(진짜 잘못된 lookup은 계속 거부)를 검증한다. 두 테스트가 정확히 패치의 두 변경(pk 분기 + `_cls=None`)에 1:1 대응하므로 "정상 통과 ∧ 오류 검출"을 동시에 못박는다.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇아 보이지만, 두 번째 테스트가 첫 번째의 naive 특수처리(pk만 통과)를 정확히 반례로 차단한다 — 사실상 CEGIS의 구별 입력 역할. 그래서 "pk만 통과시키는" overfit 패치는 통과 못 한다. overfit 위험은 오히려 낮은 편(그래서 flags에 overfit-risk 미표기).
- **regression 관점**: P2P=61, 그중 ordering 관련(`test_ordering_pointing_to_two_related_model_field`, `..._to_missing_related_field`, `..._allows_registered_lookups`, `..._to_foreignkey_field` 등)이 루프 분기 변경에 민감하다. `_cls=None` 위치나 except 폭을 잘못 잡으면 이들이 깨진다 → regression-trap 표기.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement의 신호 `models.E015` + 회귀 커밋 해시 → 코드베이스에서 `E015`/`'ordering' refers to` grep → 유일 추가 지점 `Model._check_ordering` (`django/db/models/base.py`). 회귀 커밋 `440505cb...` diff/`git blame`으로 변경된 `for part in field.split(LOOKUP_SEP)` 루프를 정확히 지목. (L0, 탐색 거의 불필요.)

2. **픽스와 올바른 일반화 이유**: 루프 안에서 (a) `if part == 'pk': fld = _cls._meta.pk` 분기로 별칭을 해석하고, (b) `if fld.is_relation: _cls = ...` 뒤에 `else: _cls = None`을 추가. 이게 special-case overfit이 아닌 이유 — pk는 모든 모델이 갖는 *보편* 별칭이라 `_meta.pk`로 일반화되고(특정 모델명에 의존 안 함), `_cls=None`은 "관계가 아니면 더 따라갈 수 없다"는 ordering lookup의 일반 불변식을 그대로 코드화한다. 두 변경 모두 입력 특정이 아니라 구조적 규칙.

3. **regression 안전**: `else: _cls = None`을 `is_relation` 분기에만 붙여 관계 추적(`get_path_info()[-1].to_opts.model`)은 손대지 않는다 → 2단계 관계 ordering(`test_ordering_pointing_to_two_related_model_field`)과 FK/missing/등록 lookup P2P가 그대로 유지. except 절(`FieldDoesNotExist, AttributeError`)을 넓히지 않아 누락 필드 검출 경로도 보존. pk 분기는 `get_field` 호출 *전*에 가지치므로 기존 비-pk 경로는 바이트 동일.

4. **함정 회피**: 오라클 없는 에이전트의 전형적 실패는 **pk 분기만 추가하고 끝내는 절반 패치**다. 그러면 `parent__field1__field2`에서 `field1`(비관계) 뒤 `field2`가 직전 관계 모델 컨텍스트로 잘못 해석돼 가짜로 통과(또는 엉뚱한 에러)되어 `test_ordering_pointing_multiple_times_to_model_fields`가 깨진다. 회피법: pk를 고치기 전에 "비관계 필드 다음에 part가 더 오면 어떻게 되나"를 반드시 따져 `_cls=None`으로 컨텍스트를 끊을 것. 둘째 함정은 `pk`를 except 블록에서 처리하려는 시도 — transform/실패 로직과 얽혀 P2P를 깨기 쉽다. 정답은 try 본문 진입부에서 별칭을 선처리하는 것.
