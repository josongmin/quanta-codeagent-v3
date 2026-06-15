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
---

# django__django-12325

## 문제 요약
MTI(Multi-Table Inheritance) 자식 모델에 `OneToOneField`가 둘 이상 같은 부모를 가리키면 pk 셋업이 꼬인다. 명시적으로 `parent_link=True`를 단 필드가 있어도, 부모를 가리키는 다른(비-parent_link) OneToOne 필드 때문에 `ImproperlyConfigured: Add parent_link=True to appname.Picking.origin.` 예외가 난다. 게다가 필드 선언 순서에 따라 동작이 달라져서, parent_link 필드를 먼저 쓰면 되고 나중에 쓰면 깨진다. 사용자는 명시적 parent_link 마커가 있는 한 순서와 무관하게 동작하길 기대한다.

## 유형 분류
- 버그 카테고리: logic / edge-case (parent_link 식별 로직이 OneToOne 다중 참조를 구분 못 함)
- 서브시스템: django ORM model metaclass / MTI parent-link 셋업
- 증상 타입: 예외 (`ImproperlyConfigured`, 그리고 순서 의존성으로 인한 silent-wrong)
- 로컬라이제이션 신호: problem_statement의 "order seems to matter", "explicit parent_link marker", hints_text의 "Not sure why we're not checking and field.remote_field.parent_link on parent links connection" 및 PR 초안이 `django/db/models/base.py`의 `parent_links` 수집 루프를 정확히 지목

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/base.py:ModelBase.__new__` — 부모-링크 수집 루프
  - `django/db/models/options.py:Options._prepare` — pk 셋업 검증
- 근본 원인: `ModelBase.__new__`가 `base._meta.local_fields`를 순회하며 `isinstance(field, OneToOneField)`이기만 하면 무조건 `parent_links[...] = field`로 등록했다. 부모를 가리키는 OneToOne이 여러 개면 **마지막** 필드가 parent_link로 덮어써져, 실제 parent_link 필드가 밀려나면 순서에 따라 잘못된 필드가 부모 링크로 잡힌다. 그 결과 `options._prepare`의 `if not field.remote_field.parent_link` 검사가 엉뚱한 필드(`origin`)를 보고 예외를 던졌다.
- 수정 요지:
  - base.py: 조건을 `isinstance(field, OneToOneField) and field.remote_field.parent_link`로 좁혀, 진짜 parent_link 마커가 달린 OneToOne만 `parent_links`에 등록. 비-parent_link OneToOne의 덮어쓰기/순서 의존성 제거.
  - options.py: `_prepare`에서 더 이상 `parent_link` 여부를 검사하지 않으므로 `if not field.remote_field.parent_link: raise ImproperlyConfigured(...)` 블록과 이제 안 쓰는 `ImproperlyConfigured` import를 삭제. parent_link 보장이 base.py 수집 단계로 이동했으니 여기 런타임 검증은 불필요·유해.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_onetoone_with_parent_model`: `Place` 부모에 `ParkingLot(Place)`가 명시적 parent_link 없이 부모를 가리키는 OneToOne(`other_place`)만 가질 때 자동 생성된 `place_ptr`가 parent_link로 잡혀야 하고 `ParkingLot.check() == []`이어야 한다.
  - `test_clash_parent_link`: 자식이 부모로 향하는 추가 OneToOne(`other_parent`)을 가질 때, 자동 parent_link(`parent_ptr`)와의 reverse accessor/query name 충돌이 `fields.E304`/`E305`로 정확히 보고되는지(예외가 아니라 check 에러로) 검증.
- 증명 방식: 기존 `test_missing_parent_link`(ImproperlyConfigured 기대)를 삭제하고, 같은 형태의 모델이 이제 예외 없이 `check()`를 통과(또는 올바른 check 에러를 내는) 것으로 대체. 즉 "예외 던지기 → check 통과"로 동작이 뒤집힌 것을 직접 관찰. 추가로 `migrations/test_state.py::test_render`가 자동 생성 parent pk 필드에 `parent_link=True` kwarg가 직렬화되는 것을 반영(렌더 회귀 가드).

## 공략 포인트 (뭘 조져야)
- 어디부터: `git grep "parent_link"` → `ModelBase.__new__`의 `parent_links` 수집 루프가 1차 타겟. hints_text/PR 초안이 이미 정확히 지목하므로 localization은 비교적 명확.
- 함정/난이도 메모:
  - 멀티파일이다. base.py만 고치면 `options._prepare`의 잔존 `ImproperlyConfigured` 검사가 여전히 터질 수 있어 두 곳을 함께 봐야 한다. 한쪽만 고치면 PASS_TO_PASS 일부/신규 테스트가 깨진다.
  - hints의 PR 초안은 `sorted(..., key=parent_link, reverse=True)` + `if related_key not in parent_links`로 "더 정교하게" 접근하지만, 골드는 단순히 **비-parent_link OneToOne을 애초에 배제**하는 최소 수정을 택했다. 과한 정렬 로직으로 가면 자동 생성 pk 경로(parent_link 없는 자동 `_ptr`)를 잘못 처리할 위험.
  - 검증 로직을 base.py로 옮기면서 options.py의 런타임 raise를 "지우는" 게 핵심인데, 단순 버그픽서는 raise를 남겨두려는 유혹이 있다.
- 우리 에이전트 관점: 예외 메시지(`Add parent_link=True to ...`)를 그대로 grep하면 options.py의 raise 지점으로만 끌려가, 진짜 원인인 base.py의 수집 루프를 놓치기 쉽다. "예외 발생 지점 ≠ 근본 원인" 분리 사고가 필요하고, 더불어 options.py raise를 제거해도 안전한지(검증 책임 이동) 확신하려면 두 파일의 호출 순서를 함께 읽어야 한다.
