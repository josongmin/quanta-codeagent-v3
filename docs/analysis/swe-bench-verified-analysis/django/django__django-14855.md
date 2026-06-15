---
instance_id: django__django-14855
repo: django/django
base_commit: 475cffd1d64c690cdad16ede4d5e81985738ceb4
version: "4.0"
difficulty: <15 min fix
created_at: 2021-09-14T01:27:01Z
fail_to_pass: 1
pass_to_pass: 325
gold_files: [django/contrib/admin/helpers.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-14855

## 문제 요약
커스텀 Admin Site에서 ForeignKey 필드가 `readonly_fields`에 들어가 있을 때, readonly 링크로 렌더되는 URL이 커스텀 사이트 경로(`/custom-admin/...`)가 아니라 기본 admin 경로(`/admin/...`)로 생성된다. 즉 잘못된 네임스페이스의 change URL이 silent하게(예외 없이) 만들어진다. 원인은 `django.contrib.admin.helpers`의 `AdminReadonlyField.get_admin_url`이 `reverse()`를 호출할 때 어느 admin 인스턴스(네임스페이스)에서 호출됐는지 알려주는 `current_app`을 넘기지 않는 것. admin의 다른 곳(예: `ModelAdmin.response_add`)은 이미 `current_app`을 쓰고 있어 동일 패턴이 누락된 케이스다. problem_statement가 파일·정확한 라인·`current_app` 해법·선례까지 모두 제시한다(release blocker, #31181 신규 기능에서 빠진 회귀).

## 유형 (정형화)
- **L0 (Pinpointed)** — 이슈 본문이 `django.contrib.admin.helpers get_admin_url`과 정확한 결함 라인 `url = reverse(url_name, args=[quote(remote_obj.pk)])`를 직접 지목하고, 고쳐야 할 키워드(`current_app`)와 참고 선례(`ModelAdmin.response_add`)까지 적어준다. `git grep get_admin_url` 한 방이면 단일 메서드로 수렴. 탐색이 사실상 없음.
- **S1 (Direct-Map)** — 이슈가 픽스를 거의 그대로 명세한다("아래 라인을 이렇게 바꾸면 고쳐진다"며 3줄 diff를 본문에 제시). 누락된 키워드 인자(`current_app=...`) 추가라는 정형 결함클래스(missing-argument)에 템플릿 매칭. 식·조건을 추론 합성할 필요(S2)도, 후보 다수를 테스트로 거르는 반복(S3/S4)도 없다. 기계적 인자 추가가 dominant.
- **K-Domain** — 픽스 자체는 한 줄이지만, `current_app`이 URL resolver의 네임스페이스 선택에 어떻게 관여하는지, 그리고 정확한 출처가 `self.model_admin.admin_site.name`(객체가 아닌 `.name` 문자열)이라는 점은 django admin 사이트/URL reversing 내부 계약 지식을 요구한다. 일반 파이썬 추론(K-Gen)만으론 `.admin_site.name`을 정확히 집기 어렵다. 다만 이슈가 이 부분도 거의 짚어줘서 지식 병목은 약하다.
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 인자 추가(S1)인 전형. "찾으면 끝, 자명"인 T-LocTrivial보다 한 칸 위인 이유는 정확한 출처 객체 선택에 도메인 지식이 살짝 끼어들기 때문(`.admin_site.name`).

## 난이도 티어
**T2 (쉬움).** 공식 라벨은 `<15 min fix`(T1 prior)지만 한 칸 올린다.
- T1로 미는 피처: 1파일·실효 3줄, `has-repro`(명확한 재현 시나리오 + 본문에 패치까지 제시), L0 핀포인트.
- T2로 끌어올리는 피처: (1) 정확한 출처 객체 선택(`self.model_admin.admin_site.name` — site 객체나 `self.admin_site`가 아님)에 약한 도메인 추론이 필요, (2) `regression-trap`이 강함 — PASS_TO_PASS 325개로 기본 `admin` 네임스페이스 동작을 하나도 깨면 안 되며, 테스트를 실제로 통과시키려면 코어 한 곳뿐 아니라 `tests/admin_views/admin.py`의 `site2`에 모델 등록을 추가해야 한다는 멀티파일 인지가 필요. 순수 한 줄이면 T1이지만 "올바른 인자 출처 + 넓은 P2P + 테스트 fixture 멀티파일" 때문에 T2가 방어 가능. T3까지 가지 않는 이유는 실질 추론(S2)이나 약한 localize 노력이 전혀 없기 때문.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/helpers.py` : `AdminReadonlyField.get_admin_url`
- 근본 원인: `reverse(url_name, args=[quote(remote_obj.pk)])`가 `current_app`을 전달하지 않는다. URL resolver는 현재 어떤 admin 인스턴스(네임스페이스)에서 reverse가 일어나는지 알 길이 없어 기본 `admin` 네임스페이스로 해석한다. 커스텀 사이트(`namespaced_admin` 등)에서는 잘못된 URL prefix가 나온다. 이 함수는 #31181(Django 3.2)에서 readonly FK 링크 기능이 추가될 때 다른 admin 경로들과 달리 `current_app`을 빠뜨린 회귀다.
- 수정 요지: `reverse(...)` 호출에 `current_app=self.model_admin.admin_site.name` 인자를 추가(단일 호출을 3줄로 풀어 씀). resolver가 이 readonly 필드를 소유한 ModelAdmin이 등록된 admin site의 이름을 current_app으로 인식해, 올바른 네임스페이스의 change URL을 생성한다. 다른 reverse 호출이나 함수 시그니처는 건드리지 않는다.

## 검증 (test_patch)
- FAIL_TO_PASS (1개): `test_readonly_foreignkey_links_custom_admin_site (admin_views.tests.ReadonlyTest)` — 커스텀 `namespaced_admin` 사이트에서 readonly FK 링크가 `namespaced_admin:...` 네임스페이스 URL로 렌더되는지 확인.
- 픽스 증명: 기존 `test_readonly_foreignkey_links`를 헬퍼 `_test_readonly_foreignkey_links(self, admin_site)`로 파라미터화하고 내부 `reverse(...)` 들을 `f'{admin_site}:...'`로 일반화한 뒤, 두 래퍼를 둔다 — `..._default_admin_site('admin')`(기존 동작 보존, PASS_TO_PASS에 포함)과 `..._custom_admin_site('namespaced_admin')`(신규, FAIL_TO_PASS). `tests/admin_views/admin.py`의 `site2`에 `ReadOnlyRelatedField`/`Language`를 등록해 커스텀 사이트에서도 동일 모델을 렌더 가능하게 한다. 픽스 전엔 커스텀 사이트 응답에 기대한 `namespaced_admin:...` URL이 없어 `assertContains` 실패, 픽스 후엔 `current_app` 덕에 통과.
- overfit 관점: special-case 통과 여지가 낮다. 픽스가 `current_app`을 무조건 `self.model_admin.admin_site.name`으로 잡는 일반 해법이라 특정 사이트명을 하드코딩하는 식의 overfit이 구조적으로 어렵다. 다만 FAIL_TO_PASS가 1개뿐이라(`overfit-risk` 자체는 약하지만) 만약 누가 default 케이스만 보고 `current_app='admin'`처럼 잘못 채우면 신규 테스트는 통과하지 못하고 default 테스트도 깨진다 — 두 wrapper가 cross-check 역할.
- regression 관점: `regression-trap` 강함. P2P 325개에는 `test_readonly_foreignkey_links_default_admin_site`를 포함해 기본 admin 네임스페이스 동작 전반, `NamespacedAdminKeepChangeListFiltersTests`, `CustomModelAdminTest` 등 네임스페이스/커스텀 사이트 인접 동작이 다수. `current_app`을 항상 넘겨도 기본 사이트에서는 동일 결과여야 하므로(같은 네임스페이스) default 케이스가 byte-identical로 유지되어야 한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `get_admin_url`과 결함 라인을 직접 지목 → `git grep "def get_admin_url"` → `django/contrib/admin/helpers.py`의 `AdminReadonlyField.get_admin_url` 단일 메서드. 본문이 선례로 든 `ModelAdmin.response_add`에서 `current_app=self.admin_site.name` 사용 패턴을 확인해 정답 인자 형태를 교차검증.
2. **픽스와 일반화**: `reverse(url_name, args=[quote(remote_obj.pk)])`에 `current_app=self.model_admin.admin_site.name` 추가. 이게 올바른 일반화인 이유 — 네임스페이스를 어떤 상수로 박는 게 아니라 "이 필드를 렌더하는 ModelAdmin이 어느 site에 등록됐는가"를 런타임에 동적으로 따라가므로, 기본 admin이든 임의 커스텀 사이트든 모두 올바른 prefix가 나온다. resolver의 current_app 메커니즘이 정확히 이 용도(동일 ModelAdmin이 여러 site에 등록 가능)로 설계돼 있어 계약에 맞는 수정.
3. **regression 안전**: 기본 `admin` 사이트에서는 `self.model_admin.admin_site.name == 'admin'`이라 `current_app` 명시가 결과 URL을 바꾸지 않는다 → `test_readonly_foreignkey_links_default_admin_site`를 비롯한 P2P 325개가 그대로 통과. `reverse` 호출 외 함수 시그니처/리턴(`NoReverseMatch` 시 `str(remote_obj)` fallback)은 손대지 않아 예외 경로도 보존.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `current_app`에 site 객체나 `self.admin_site`(이 컨텍스트에 없음)를 넘김 → `.name` 문자열이어야 하고 출처는 `self.model_admin.admin_site`. (b) 코어 한 줄만 고치고 테스트 fixture를 잊음 — `site2`에 `ReadOnlyRelatedField`/`Language`를 등록하지 않으면 커스텀 사이트에서 모델이 안 떠 자기 검증이 비어버린다(멀티파일 인지 필요). (c) over-engineering — 다른 `reverse` 호출까지 일괄 변경하려는 유혹. 골드는 딱 이 한 호출에 인자만 추가하므로 범위를 넘기면 회귀 위험만 키운다.
