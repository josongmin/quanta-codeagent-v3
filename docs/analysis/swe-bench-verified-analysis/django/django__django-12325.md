---
instance_id: django__django-12325
repo: django/django
base_commit: 29c126bb349526b5f1cd78facbe9f25906f18563
version: 3.1
difficulty: 1-4 hours
created_at: 2020-01-15T14:02:25Z
fail_to_pass: 2
pass_to_pass: 201
gold_files: [django/db/models/base.py, django/db/models/options.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-12325

## 문제 요약
MTI(Multi-Table Inheritance) 자식 모델이 같은 부모를 가리키는 `OneToOneField`를 둘 이상 가질 때 부모-링크(parent_link) pk 셋업이 꼬인다. 명시적으로 `parent_link=True`를 단 필드(`document_ptr`)가 있어도, 부모를 가리키는 다른 비-parent_link OneToOne(`origin`) 때문에 `django.core.exceptions.ImproperlyConfigured: Add parent_link=True to appname.Picking.origin.` 예외가 난다. 더 나아가 필드 선언 **순서**가 동작을 바꿔서, parent_link 필드를 먼저 쓰면 통과하고 나중에 쓰면 깨진다(이슈 본문에 reproduce 코드 두 버전이 있음). 사용자는 명시적 parent_link 마커가 있으면 순서와 무관하게 동작해야 한다고 주장하며, 이것이 실제 버그다.

## 유형 (정형화)

3축 점수:
- **L1 (Traceable)** — 이슈/hints가 심볼을 직접 지목하지는 않지만(`Add parent_link=True to ...` 예외 메시지는 *증상* 지점인 options.py로 끌고 감), hints_text에 "Not sure why we're not checking `and field.remote_field.parent_link` on parent links connection" + PR 초안 diff가 `django/db/models/base.py`의 `parent_links` 수집 루프를 정확히 가리킨다. `git grep "parent_link"`로 단일 후보 루프에 수렴 가능. 순수 L0(grep 한 방)은 아닌 이유: 진짜 근본원인 파일(base.py)은 예외 메시지로는 안 나오고 호출 순서를 따라가야 보인다.
- **S2 (Constraint-Reasoning) (+S6)** — 픽스 위치는 알아도 *올바른 술어*를 추론으로 합성해야 한다. 핵심은 "OneToOne이면 무조건 parent_link로 등록"이라는 잘못된 불변식을, "parent_link 마커가 달린 OneToOne만 부모 링크 후보"라는 의도된 불변식으로 교정하는 것. 한 줄짜리 조건식 강화처럼 보이지만, 그 조건이 옳다는 걸 보장하려면 검증 책임을 options.py 런타임 raise에서 base.py 수집 단계로 **재배치**해야 하므로 보조적으로 S6(작은 lifecycle 재배치) 성격이 붙는다.
- **K-Domain** — Django MTI 내부 지식이 병목. `ModelBase.__new__` 메타클래스 흐름, `_meta.local_fields`, `remote_field.parent_link`, 자동 생성 `*_ptr` 필드, `Options._prepare`의 pk 셋업 등 ORM 내부 계약을 알아야 "왜 origin이 parent_link로 오인되는지"와 "options.py raise를 지워도 안전한지"를 판단할 수 있다. 일반 파이썬 추론(K-Gen)만으로는 도달 불가.

primary type = **T-ConstraintReason**: 위치는 비교적 명확(L1)하지만 난점이 "어디"가 아니라 "어떤 조건이 올바른 일반화인가"의 의미 추론(S2)에 있다. T-DirectMap이 아닌 이유는, 단순 None가드/기본값 같은 템플릿 결함클래스가 아니라 잘못된 불변식 자체를 재정의하고 검증 위치를 옮기는 의미적 수정이기 때문. T-DomainBound로 분류하지 않은 이유는 도메인 지식이 필수이긴 해도 dominant 병목은 "지식 결핍"보다 "올바른 조건식 합성"이라서다(K-Domain은 보조 신호로 표기).

## 난이도 티어

**T4 (약간 어려움)**. 공식 라벨은 "1-4 hours"(T4 prior와 정합)이고, 구조적 피처도 T4로 민다:
- **멀티파일 cross-file 수정(L3 경계의 L1)**: base.py + options.py 2파일을 **함께** 바꿔야 한다. base.py에서 조건을 좁히는 것과 options.py에서 런타임 raise를 제거하는 것이 한 쌍이다. 한쪽만 고치면 깨진다(아래 검증 참조). 순수 cross-file 조율은 아니라 L3까지 가진 않지만 cross-file-dep 플래그가 붙는다.
- **넓은 P2P trap(regression-trap)**: PASS_TO_PASS가 **201개**로 매우 광범위하다 — `migrations.test_state`의 RelatedModelsTests/StateTests/ModelStateTests, `invalid_models_tests`의 거의 모든 clash 검사군. parent_link 수집 로직과 pk 셋업은 MTI·migration state 렌더링·reverse accessor 충돌 검사 전반에 닿아 있어, 조건을 잘못 좁히면 자동 생성 `*_ptr` 경로나 state 직렬화가 광범위하게 깨진다.
- **localize 직접성은 중간(L1)**: has-repro(이슈에 reproduce 모델 2종 + 더 단순한 케이스까지)라 재현은 쉬워 난이도를 아래로 당기지만, 예외 발생 지점(options.py)과 근본 원인(base.py)이 분리돼 있어 "증상≠원인" 사고가 필요. 이 분리가 T3가 아닌 T4로 미는 요인.
- **도메인 지식(K-Domain)**: MTI parent-link 셋업이라는 ORM 내부 영역.

T5가 아닌 이유: 헌크가 작고(2파일 합쳐 핵심 변경 1줄 강화 + 1블록 삭제), overfit 위험이 낮으며(F2P가 양/음 케이스 모두 커버) 깊은 멀티-사이트 조율은 없다. T3가 아닌 이유: 넓은 P2P trap + cross-file 쌍 수정 + 증상/원인 분리가 단일파일 가벼운 추론 수준을 넘는다.

## 골드패치 분석

건드린 파일·함수:
- `django/db/models/base.py` — `ModelBase.__new__` 내부 부모-링크 수집 루프
- `django/db/models/options.py` — `Options._prepare` (pk 셋업) + 상단 `ImproperlyConfigured` import

근본 원인: `ModelBase.__new__`가 `base._meta.local_fields`를 순회하며 `isinstance(field, OneToOneField)`이기만 하면 무조건 `parent_links[make_model_tuple(related)] = field`로 등록했다. 부모를 가리키는 OneToOne이 여러 개면 같은 `related` 키에 대해 **마지막으로 순회된** 필드가 앞 것을 덮어쓴다. 따라서 진짜 `parent_link=True` 필드(`document_ptr`)가 비-parent_link 필드(`origin`)에 의해 밀려나면, `Options._prepare`가 부모 링크로 잡은 필드를 보고 `if not field.remote_field.parent_link: raise ImproperlyConfigured('Add parent_link=True to %s.')`를 던진다. 선언 순서가 동작을 좌우한 것이 바로 이 dict 덮어쓰기 때문.

수정 요지:
- **base.py**: 수집 조건을 `isinstance(field, OneToOneField) and field.remote_field.parent_link`로 좁힌다. 진짜 parent_link 마커가 달린 OneToOne만 `parent_links`에 등록 → 비-parent_link OneToOne의 덮어쓰기/순서 의존성이 원천 제거됨. (자동 생성되는 `*_ptr` 필드도 parent_link=True를 갖도록 보장되므로 자동 pk 경로도 이 조건을 통과.)
- **options.py**: `_prepare`에서 더 이상 parent_link 미설정을 런타임에 raise하지 않는다. `if not field.remote_field.parent_link: raise ImproperlyConfigured(...)` 블록 전체와, 이제 안 쓰이는 `ImproperlyConfigured` import를 삭제. parent_link 보장 책임이 base.py 수집 단계로 이동했으므로 여기 런타임 검증은 불필요할 뿐 아니라(이미 base.py가 올바른 필드를 골랐다) 잘못된 필드를 검사하던 유해 코드라 제거가 정합적이다.

## 검증 (test_patch)

FAIL_TO_PASS (2개):
- `test_onetoone_with_parent_model` (`invalid_models_tests.test_models.OtherModelTests`): `ParkingLot(Place)`가 명시적 parent_link 없이 부모를 가리키는 OneToOne(`other_place`)만 가질 때, 자동 생성 `place_ptr`가 parent_link로 올바르게 잡혀 `ParkingLot.check() == []`이어야 한다. 픽스 전에는 `other_place`가 부모 링크로 오인돼 ImproperlyConfigured가 났다.
- `test_clash_parent_link` (`invalid_models_tests.test_relative_fields.ComplexClashTests`): 자식이 부모로 향하는 추가 OneToOne(`other_parent`)을 가질 때, 자동 parent_link(`parent_ptr`)와의 reverse accessor/query name 충돌이 **예외가 아니라** `fields.E304`/`E305` check 에러 4종으로 정확히 보고돼야 함을 검증.

픽스 증명: 기존 `test_missing_parent_link`(ImproperlyConfigured 기대)를 **삭제**하고, 동일 형태 모델이 이제 예외 없이 `check()`를 통과하거나 올바른 check 에러를 내도록 대체했다. 즉 "예외 던지기 → 정상 check"로 동작이 뒤집힌 것을 직접 관찰한다. 추가로 `migrations/test_state.py::test_render`가 자동 생성 parent pk 필드 직렬화에 `parent_link=True` kwarg가 포함되도록 기대값을 갱신 — 수집 조건이 parent_link에 의존하게 됐으니 state 렌더가 이를 보존해야 한다는 회귀 가드.

overfit·regression 관점:
- **overfit 낮음**: F2P가 양성(parent_link 없는 자동 pk가 잘 잡혀야 함)과 음성(추가 OneToOne 충돌은 여전히 E304/E305로 잡혀야 함) 양방향을 다 커버한다. special-case로 통과시키는 패치(예: `origin`만 특별 처리)는 `test_clash_parent_link`를 통과 못 한다.
- **regression 위험 높지만 가드 충분**: 201개 P2P가 RelatedModelsTests·StateTests·다양한 clash 검사를 광범위하게 덮어, 조건을 잘못 좁히면(예: 자동 `*_ptr`까지 배제) 즉시 적발된다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 예외 메시지 `Add parent_link=True to ...`를 grep하면 `django/db/models/options.py::Options._prepare`의 raise로 끌려간다 — 이게 함정. 여기서 멈추지 말고 "왜 `field`가 잘못된 필드(`origin`)냐"를 역추적해야 한다. hints_text의 "we're not checking `and field.remote_field.parent_link` on parent links connection"이 결정적 신호 → `parent_links`가 채워지는 곳 `django/db/models/base.py::ModelBase.__new__`의 `for field in base._meta.local_fields:` 수집 루프가 진짜 근본 원인. has-repro로 두 순서 버전을 직접 돌려 dict 덮어쓰기 가설을 확인.
2. **픽스와 왜 올바른 일반화인가**: 수집 조건을 `and field.remote_field.parent_link`로 강화 → "parent_link 마커가 진짜 의도된 부모 링크"라는 도메인 불변식과 정확히 일치. 이게 overfit이 아닌 이유: `origin`을 이름으로 특별 처리하는 게 아니라 *마커 부재*라는 구조적 속성으로 배제하므로, 부모를 가리키는 임의의 추가 OneToOne 전부에 일반화된다. 동시에 검증 책임을 options.py 런타임 raise에서 base.py 수집 단계로 이전하고 raise 블록·import를 제거 — 올바른 필드를 base.py가 이미 골랐으니 후단 검사는 잉여·유해.
3. **regression 안전**: P2P 201개 중 핵심은 (a) 자동 생성 `*_ptr` 경로 — 자동 pk OneToOne도 parent_link=True라 강화된 조건을 통과해야 하고, `test_render`가 직렬화에 `parent_link=True`를 요구. (b) RelatedModelsTests/StateTests의 MTI·migration state 그래프 — 부모 링크 식별이 바뀌면 깨질 수 있으니, 조건을 *마커 있는 것만 포함*으로만 좁히고 *마커 있는 것을 누락*하지 않아야 한다. (c) 기존 reverse-accessor clash 검사군이 그대로 동작해야 함.
4. **함정 회피**: (i) 예외 지점=options.py에 머물러 raise만 무력화하면, base.py가 여전히 틀린 필드를 부모 링크로 잡아 다른 곳에서 깨진다 — "증상≠원인" 분리 필수. (ii) hints의 PR 초안처럼 `sorted(..., key=parent_link, reverse=True)` + `if related_key not in parent_links`로 *정교하게* 가는 유혹 — 골드는 비-parent_link OneToOne을 **애초에 배제**하는 최소 수정을 택했다. 과한 정렬 로직은 자동 `*_ptr` 경로나 동일 부모 다중 링크 처리에서 미묘한 회귀를 부를 수 있다. (iii) base.py만 고치고 options.py의 raise·import를 남겨두면 dead 검증이 잘못된 필드를 보고 여전히 터지거나 lint 회귀 — 두 파일을 한 쌍으로 봐야 한다.
