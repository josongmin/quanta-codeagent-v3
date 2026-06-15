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
---

# django__django-14855

## 문제 요약
커스텀 Admin Site에서 ForeignKey 필드가 `readonly_fields`에 들어가 있을 때, readonly 링크로 렌더되는 URL이 커스텀 사이트 경로(`/custom-admin/...`)가 아니라 기본 admin 경로(`/admin/...`)로 생성된다. 사용자는 현재 커스텀 admin 네임스페이스를 따르는 링크를 기대했다. 원인은 `django.contrib.admin.helpers`의 `get_admin_url`이 `reverse()`를 호출할 때 `current_app`을 넘기지 않는 것으로, admin 다른 곳(예: `ModelAdmin.response_add`)은 이미 `current_app`을 쓰고 있다.

## 유형 분류
- 버그 카테고리: 누락처리 (regression — #31181 신규 기능에서 빠진 케이스)
- 서브시스템: django contrib.admin / readonly field 렌더링 (URL reversing)
- 증상 타입: 잘못된 출력 (틀린 URL이 silent하게 생성됨, 예외 없음)
- 로컬라이제이션 신호: problem_statement가 `django.contrib.admin.helpers get_admin_url`과 정확한 라인 `url = reverse(url_name, args=[quote(remote_obj.pk)])`를 명시적으로 지목하고, `current_app` 키워드와 `ModelAdmin.response_add` 선례까지 제시 — 거의 핀포인트.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/helpers.py` : `AdminReadonlyField.get_admin_url`
- 근본 원인: `reverse(url_name, args=[quote(remote_obj.pk)])`가 `current_app`을 전달하지 않아, URL resolver가 어떤 admin 인스턴스(네임스페이스)에서 호출됐는지 모르고 기본 `admin` 네임스페이스로 reverse한다. 커스텀 사이트에서는 잘못된 prefix가 나온다.
- 수정 요지: `reverse(...)` 호출에 `current_app=self.model_admin.admin_site.name`을 추가한다. 이렇게 하면 resolver가 해당 readonly 필드를 소유한 ModelAdmin이 등록된 admin site의 이름을 current_app으로 인식해, 올바른 네임스페이스의 change URL을 생성한다. 단 한 곳, 3줄 추가.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_readonly_foreignkey_links_custom_admin_site` — 커스텀(`namespaced_admin`) 사이트에서 readonly FK 링크가 올바른 네임스페이스 URL로 렌더되는지 확인.
- 테스트가 어떻게 픽스를 증명하는지: 기존 `test_readonly_foreignkey_links`를 헬퍼 `_test_readonly_foreignkey_links(self, admin_site)`로 파라미터화하고, 내부의 `reverse(...)` 들을 `f'{admin_site}:...'`로 일반화했다. 그 위에 두 래퍼를 둔다 — `..._default_admin_site('admin')`(기존 동작, PASS_TO_PASS)과 `..._custom_admin_site('namespaced_admin')`(신규, FAIL_TO_PASS). `tests/admin_views/admin.py`의 `site2`에 `ReadOnlyRelatedField`/`Language`를 등록해 커스텀 사이트에서도 동일 모델을 렌더할 수 있게 한다. 픽스 전엔 커스텀 사이트 응답에 기대한 `namespaced_admin:...` URL이 없어 `assertContains` 실패, 픽스 후엔 `current_app` 덕에 통과.

## 공략 포인트 (뭘 조져야)
- 어디부터: `git grep get_admin_url` → `django/contrib/admin/helpers.py`의 `AdminReadonlyField.get_admin_url` 단일 메서드. problem_statement가 파일·라인·해법까지 다 줘서 localization은 거의 공짜.
- 함정/난이도: `self.model_admin.admin_site.name`이 정확한 출처인지(AdminReadonlyField가 `model_admin`을 보유하는지) 확인 필요. 비슷하게 보이는 `current_app=self.admin_site` 같은 잘못된 객체를 넘기면 안 됨 — `.name` 문자열이어야 한다. 코드 픽스는 단일 파일이지만, 테스트를 통과시키려면 `tests/admin_views/admin.py`의 `site2`에 모델 등록을 추가해야 하므로 멀티파일 인지가 필요하다(에이전트가 코어만 고치고 테스트 fixture를 안 만들면 자기 검증이 비어버림).
- 우리 에이전트 관점: 코어 수정 자체는 자명. 막힐 만한 지점은 (1) `current_app`에 site 객체가 아닌 `.name` 문자열을 넘겨야 한다는 미묘함, (2) 회귀 방지를 위해 기본 admin 케이스가 깨지지 않는지(PASS_TO_PASS 270개) 확신하는 것. 골드는 한 줄 호출에 인자만 추가하므로 over-engineering(다른 reverse 호출까지 건드리는) 유혹을 피해야 한다.
