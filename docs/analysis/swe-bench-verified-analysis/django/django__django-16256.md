---
instance_id: django__django-16256
repo: django/django
base_commit: 76e37513e22f4d9a01c7f15eee36fe44388e6670
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-11-04T14:26:44Z
fail_to_pass: 9
pass_to_pass: 53
gold_files: [django/contrib/contenttypes/fields.py, django/db/models/fields/related_descriptors.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-16256

## 문제 요약
QuerySet에 async 인터페이스(커밋 58b27e0)가 추가되면서 관련 매니저(related manager)에도 의도치 않게 `acreate()`, `aget_or_create()`, `aupdate_or_create()`가 노출됐다. 이 메서드들은 매니저가 자체적으로 재정의한 동기 `create()`/`get_or_create()`/`update_or_create()`(부모 인스턴스의 FK / content_type / object_id 주입, m2m through 처리 로직 포함)를 호출하지 않고, QuerySet에서 상속한 async 버전을 그대로 호출해 버린다. 결과적으로 부모 관계가 연결되지 않은 객체가 조용히 생성된다(release blocker). 기대 동작은 동기 매니저 메서드와 동일하게 부모 관계를 채운 채 비동기로 동작하는 것.

## 유형 (정형화)

**3축 점수**

- **L = L3 (Multi-site)** — 수정이 2개 src 파일(`related_descriptors.py`, `contenttypes/fields.py`)의 3개 매니저 팩토리(`create_reverse_many_to_one_manager`, `create_forward_many_to_many_manager`의 `ManyRelatedManager`, `GenericRelatedObjectManager`)에 **함께** 들어가야 하고, 각 팩토리마다 3개 메서드를 미러링해야 한다. 한 파일/한 매니저만 고치면 FAIL_TO_PASS가 부분 통과 → 조율된 멀티사이트 수정.
- **S = S1 Direct-Map (+S6)** — 픽스 자체는 완전히 기계적이다. problem_statement가 정확한 파일·함수·diff 스케치(`async def acreate(self, **kwargs): return await sync_to_async(self.create)(**kwargs)`)를 거의 그대로 적어줘서 템플릿 매칭(S1)이다. 다만 동기 메서드 "옆에 비동기 짝을 lifecycle-pair로 배치"하는 **반복적 구조 미러링**이라 S6(소규모 design 미러)을 보조로 단다.
- **K = K-Domain** — `sync_to_async`로 감싸야 할 대상이 **매니저 자신의 동기 메서드**(self.create)이지 QuerySet의 async 메서드가 아니라는 점, m2m의 `through_defaults` 키워드-온리 시그니처, generic relation도 동일 패밀리라는 점은 django related-manager 내부 구조 지식이 있어야 안다. 일반 파이썬 async 지식만으론 부족.

**primary type = T-DomainBound** — 픽스가 자명(S1)하고 위치 신호도 강하지만, 진짜 병목은 "django related manager 3패밀리 × forward/reverse × generic의 전수 커버리지"라는 도메인 구조 지식이다. T-DirectMap(S1 기계적)도 후보지만, 멀티사이트 전수성과 generic 파일이 본문에 명시되지 않은 점이 K-Domain을 dominant로 만들어 T-DomainBound가 맞다.

왜 이 repair strategy(S1+S6)인가 — APR 관점에서 이건 결함클래스가 "wrong-method-resolution(상속 async가 override를 가림)"으로 정형화되고, 픽스 템플릿이 이슈 본문에 명세되어 있으므로 SemFix류 추론(S2)이나 G&V 반복(S3)이 불필요하다. 각 동기 메서드에 1:1로 async 래퍼를 PAR/TBar식 패턴 적용(S1)하면 끝. 단 적용 지점이 분산되어 있어 "collect-then-mirror"라는 가벼운 구조 작업(S6)이 동반된다.

## 난이도 티어
**T4 (약간 어려움)**.

이 티어로 미는 구조적 피처:
- **L3 멀티사이트 + cross-file-dep**: 2 src 파일, 3 매니저 팩토리, 9개 신규 메서드. ICLR 2024 컷에서 멀티파일은 solve-rate를 크게 떨어뜨리는 1차 요인. 전수 누락 위험이 핵심 난점.
- **K-Domain**: generic relations 파일(`contenttypes/fields.py`)은 problem_statement에 **명시되지 않음**. async 동작이 같은 패밀리임을 알아야 자발적으로 포함 → 도메인 지식 게이트.
- **넓은 P2P trap (regression-trap)**: PASS_TO_PASS 53개가 대부분 generic_relations 동기 동작(add/set/clear/get_or_create/update_or_create/prefetch). 동기 메서드를 건드리거나 시그니처를 바꾸면 즉시 깨진다.

공식 라벨은 "15분-1시간"으로 T2~T3급을 시사하지만, 그건 **답을 아는 코어 개발자의 구현 시간**(픽스 자체가 기계적이라 짧음)이다. 오라클 없는 에이전트 관점에서는 (a) generic 파일이 본문 밖이라 localize에서 1/3을 빠뜨릴 위험, (b) `sync_to_async` 대상을 헷갈려 버그 재현, (c) 53개 P2P를 안 깨야 하는 부담이 시간라벨에 안 잡히는 난이도를 더한다. 그래서 한 칸 올려 T4.

## 골드패치 분석
- **건드린 파일·함수**
  - `django/db/models/fields/related_descriptors.py`
    - `create_reverse_many_to_one_manager(...)` 내부 매니저: `acreate`, `aget_or_create`, `aupdate_or_create` 추가
    - `create_forward_many_to_many_manager(...)`의 `ManyRelatedManager`: `acreate`, `aget_or_create`, `aupdate_or_create` 추가(키워드-온리 `*, through_defaults=None` 보존)
  - `django/contrib/contenttypes/fields.py`
    - `GenericRelatedObjectManager`: `acreate`, `aget_or_create`, `aupdate_or_create` 추가
  - 두 파일 상단에 `from asgiref.sync import sync_to_async` import 추가
- **근본 원인**: 커밋 58b27e0이 QuerySet에 async 인터페이스를 넣자, 매니저가 QuerySet에서 상속한 `acreate`/`aget_or_create`/`aupdate_or_create`가 매니저가 재정의한 동기 버전(`kwargs[self.field.name] = self.instance`, content_type/object_id 설정, `super(ManyRelatedManager, self.db_manager(db))...` + `through_defaults` 처리)을 우회한다. 즉 메서드 해석이 "매니저 동기 override"가 아니라 "QuerySet async"로 빠져 부모 관계 주입이 통째로 누락된다.
- **수정 요지**: 각 동기 메서드 바로 옆에 매니저 자신의 동기 버전을 `sync_to_async(self.create)(**kwargs)`로 감싸는 비동기 짝을 명시적으로 정의해 override가 상속을 가리게 한다. m2m은 `through_defaults=through_defaults`를 명시 전달. 9개 신규 메서드 전부에 `alters_data = True`를 달아 템플릿 호출 금지 계약을 유지.

## 검증 (test_patch)
- **FAIL_TO_PASS 9개**가 세 경로 × 세 메서드를 격자로 커버:
  - reverse FK(`s1.relatedmodel_set`): `test_acreate_reverse`, `test_aget_or_create_reverse`, `test_aupdate_or_create_reverse`
  - forward m2m(`mtm1.simples`): `test_acreate`, `test_aget_or_create`, `test_aupdate_or_create`
  - generic(`bacon.tags`): `test_generic_async_acreate`, `test_generic_async_aget_or_create`, `test_generic_async_aupdate_or_create`
- **픽스 증명 방식**: `test_acreate`는 `await self.mtm1.simples.acreate(field=2)` 후 `await self.mtm1.simples.aget()`로 같은 m2m 매니저에서 조회 — 관계가 실제 연결됐음을 입증(버그 시 QuerySet 경로라 through 미연결로 조회 실패). `test_aget_or_create`/`aupdate_or_create`는 `created` 불리언, `acount()`(중복 미생성), through_defaults/defaults 반영을 검증. reverse 테스트는 `.simple == self.s1`로 FK 주입 확인. 신규 모델 `ManyToManyModel`(`tests/async/models.py`)과 새 파일 `tests/async/test_async_related_managers.py`, generic은 기존 `generic_relations/tests.py`에 3 케이스 추가.
- **overfit 관점**: FAIL_TO_PASS가 forward/reverse/generic 3경로를 모두 격자로 짚어 special-case 통과 여지가 작다. 한 매니저만 고치면 즉시 다른 경로 테스트가 RED → 전수 커버리지를 강제. overfit-risk 낮음.
- **regression 관점**: PASS_TO_PASS 53개가 동기 generic 동작 전반을 지킨다. 픽스가 **순수 additive**(기존 동기 메서드 미수정, async 메서드만 신설)라 인접 동작을 깰 표면적이 거의 없다 — regression-trap이 존재하나 패치 형태가 그 함정을 구조적으로 회피.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement가 커밋 58b27e0과 `django/db/models/fields/related_descriptors.py`의 `create_reverse_many_to_one_manager` / `create_forward_many_to_many_manager` + diff 스케치를 직접 준다 → 거기로 직행. 결정적으로, "related managers 전반에 의도치 않게 노출됐다"는 표현을 단서로 `grep "create.alters_data = True"`(또는 동기 `create`/`get_or_create`/`update_or_create` 정의)를 전 매니저 팩토리에 돌려 **forward m2m·reverse FK·generic 세 패밀리**를 빠짐없이 수집한다. 이 grep이 본문에 없는 `contenttypes/fields.py`의 `GenericRelatedObjectManager`까지 끌어와야 한다.
2. **픽스와 왜 올바른 일반화인가**: 각 동기 메서드 옆에 `async def aX(self, ...): return await sync_to_async(self.X)(...)`를 추가하고 `aX.alters_data = True`. **반드시 `self.create`(매니저 동기 버전)를 감싼다** — 그래야 부모 관계 주입 로직을 타기 때문. m2m은 키워드-온리 시그니처와 `through_defaults` 전달을 보존. 이는 overfit이 아니라 올바른 일반화다: 모든 related manager가 "동기 메서드는 부모 관계를 주입하고, async는 그 동기 버전을 sync_to_async로 감싼다"는 단일 규칙을 따르므로 forward/reverse/generic/모든 메서드에 동형 적용된다.
3. **regression 안전**: 픽스는 동기 메서드를 전혀 건드리지 않는 순수 additive라 PASS_TO_PASS 53개(동기 add/set/clear/get_or_create/update_or_create/prefetch 전반)를 깰 수 없다. `alters_data = True`를 모든 신규 메서드에 다는 것이 보안 계약(템플릿 호출 금지)을 유지해 잠재 회귀를 막는다.
4. **함정 회피**: 오라클 없는 에이전트의 전형 실패는 (a) **본문에 안 적힌 generic 파일 누락** → generic FAIL_TO_PASS 3개 RED. grep으로 전 매니저 패밀리를 열거해 회피. (b) `sync_to_async(self.create)` 대신 상속 async(QuerySet `acreate`)를 호출 → 버그 그대로 재현. (c) m2m에서 `through_defaults`를 빠뜨리거나 키워드-온리(`*`)를 잃어 시그니처 회귀. (d) `alters_data = True` 누락 — 테스트는 통과해도 보안 계약 위반. 핵심은 "동기 메서드 위치를 전부 grep → 1:1 미러링" 하는 체계적 전수 적용.
