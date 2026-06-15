---
instance_id: django__django-16139
repo: django/django
base_commit: d559cb02da30f74debbb1fc3a46de0df134d2d80
version: 4.2
difficulty: <15 min fix
created_at: 2022-09-30T08:51:16Z
fail_to_pass: 1
pass_to_pass: 86
gold_files: [django/contrib/auth/forms.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-16139

## 문제 요약
admin에서 다른 모델이 `to_field="uuid"` 같은 식으로 User를 참조하면 UserAdmin이 pk가 아니라 to_field 값으로 접근된다(`.../user/2222.../change/?_to_field=uuid`). 이때 `UserChangeForm`의 password 필드 `help_text`에 박히는 비밀번호 변경 링크가 상대경로 `../password/`로 하드코딩돼 있어, URL 세그먼트 기준점이 어긋나 잘못된 곳으로 풀리고 404가 난다. 어느 URL 형태로 폼에 접근하든 password 변경 링크가 올바른 곳을 가리켜야 한다는 기대를 위반한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — problem_statement가 `UserChangeForm` 클래스 본문과 `password.help_text.format("../password/")` 라인을 코드 그대로 인용하고, 심지어 수정안 한 줄까지 제시한다. `grep "help_text.format"` 또는 `grep "../password/"` 한 방이면 `django/contrib/auth/forms.py`의 `UserChangeForm.__init__`로 직행한다. 탐색이 사실상 0이다.
- **S (Repair Strategy) = S1 (Direct-Map) +S2 (Constraint-Reasoning)** — 이슈 본문이 픽스를 사실상 명세(`"../password/"` → `f"../../{self.instance.pk}/password/"`)하므로 dominant는 S1(템플릿/직접 매핑). 다만 "왜 한 단계 더 올라가서 pk를 다시 박는가"를 정당화하려면 admin change URL의 세그먼트 구조(`<id>/change/` vs `<pk>/password/`)와 상대경로 기준점이 to_field 접근 시 어떻게 어긋나는지에 대한 경로 산술 추론이 필요해 S2가 보조로 붙는다.
- **K (Knowledge) = K-Domain** — 일반 파이썬 추론만으로는 `f"../../{self.instance.pk}/password/"`가 정확히 맞는 상대경로임을 확신할 수 없다. django admin의 URL 라우팅 규약(change view가 `<object_id>/change/`로 매핑되고 password change가 같은 prefix 하위 `<pk>/password/`라는 점), `to_field`/`_to_field` 메커니즘, `self.instance.pk`가 폼 인스턴스에서 가용하다는 ModelForm 계약을 알아야 한다.
- **Primary = T-DirectMap** — 위치가 L0로 명확하고, 픽스가 "상수 문자열 인자 교체"라는 기계적 형태다. 진짜 어려움이 localize(T-DiffuseLoc)나 스펙 재구성(T-SpecInference)에 있지 않고, 명세된 픽스를 정확한 경로 문자열로 매핑하는 데 있으므로 T-DirectMap이 dominant. S2 보조 추론은 픽스의 정당화일 뿐 후보 다수를 테스트로 수렴(S3/S4)하는 성격이 아니다.

## 난이도 티어
**T2 (쉬움)**. 공식 라벨은 `<15 min fix`로 prior와 일치한다.
- 미는 피처: 단일 파일(`forms.py`) 단일 헌크 1라인 교체, L0 직접 localize, has-repro(이슈가 재현 URL과 코드·수정안까지 제시 — 가장 강한 easiness 신호), 구조컷상 1파일·<5줄(≈48% solve 구간).
- T1로 안 내려가는 이유: K-Gen이 아니라 K-Domain이다. `../../{pk}/`라는 정확한 상대경로 산술은 admin URL 구조 지식 없이는 자명하지 않고, 한 단계만 틀려도(`../password/`를 유지하거나 `../`/`../../../`로 잘못 세면) 테스트가 깨진다. 또 PASS_TO_PASS 86개 중 `UserChangeFormTest`/`PasswordChangeFormTest` 등 password help_text·렌더 동작이 인접해 있어 regression-trap이 약하게 존재한다.
- T3 이상으로 안 올라가는 이유: 실질 추론이 단일 라인의 경로 문자열 합성에 국한되고, 멀티사이트 조율·overfit 위험·깊은 call-chain이 없다.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/auth/forms.py` → `UserChangeForm.__init__`.
- **근본 원인**: `password.help_text.format("../password/")`의 상대경로 `../password/`는 폼이 정확히 `.../user/<pk>/change/` URL에서 렌더될 때만 password change 페이지(`.../user/<pk>/password/`)로 올바르게 resolve된다. to_field로 접근하면 URL이 `.../user/<to_field_value>/change/?_to_field=...` 형태가 되어 상대경로 기준점은 같지만, 골드는 접근 경로에 무관하게 항상 실제 pk 기반 경로로 고정하기 위해 상대경로 자체를 재구성한다.
- **수정 요지**: 포맷 인자를 `"../password/"` → `f"../../{self.instance.pk}/password/"`로 교체. `../../`로 change view 세그먼트(`<id>/change/`)를 두 단계 거슬러 admin user changelist 레벨까지 올라간 뒤, 인스턴스의 실제 `pk`를 명시해 `<pk>/password/`를 다시 내려 붙인다. 결과적으로 폼이 pk URL이든 to_field URL이든 동일하게 정식 pk 기반 password change 경로를 가리킨다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_link_to_password_reset_in_helptext_via_to_field (auth_tests.test_forms.UserChangeFormTest)`.
- **픽스 증명**: `@override_settings(ROOT_URLCONF="auth_tests.urls_admin")` 하에서 `testclient` User로 `UserChangeForm(data={}, instance=user)`를 만들고, `password` 필드 help_text에서 `<a href="(.*?)">` 링크를 정규식 추출한다. to_field(username) 기반 change URL `reverse("admin:auth_user_change", args=(user.username,))`에 추출 링크를 `urllib.parse.urljoin`으로 결합한 결과가, pk 기반 정식 URL `reverse("admin:auth_user_password_change", args=(user.pk,))`과 정확히 일치하는지 단언한다. 즉 to_field로 접근한 base URL에서 골드의 상대경로가 올바른 password change 페이지로 resolve됨을 직접 검증한다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, `urljoin`으로 실제 URL resolution을 거쳐 정식 reverse 결과와 동치를 따지므로 단순 문자열 매칭보다 강하다. 다만 픽스가 `self.instance.pk`에 의존하므로, 바운드 인스턴스만 테스트되고 unbound/`pk is None` 경로는 미검증이다 — 골드는 이를 의도적으로 방어하지 않아 special-case 일반화(S1)에 머문다.
- **regression 관점**: PASS_TO_PASS 86개가 `password_help_text`, `bug_19349_bound_password_field`, ReadOnly/AdminPasswordChange 등 password 필드 렌더·help_text 동작을 광범위하게 커버한다. help_text 포맷 문자열만 바꾸므로 이 인접 동작들이 그대로 통과해야 회귀가 없다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `UserChangeForm` 코드와 `password.help_text.format("../password/")`를 그대로 인용 → `grep -rn 'help_text.format' django/contrib/auth/forms.py` 또는 `"../password/"` 리터럴 검색 → `UserChangeForm.__init__` 단일 헌크로 즉시 수렴. 탐색 비용 ~0.
2. **픽스와 일반화 정당성**: `"../password/"`를 `f"../../{self.instance.pk}/password/"`로 교체. 올바른 일반화인 이유 — 버그의 본질은 "상대경로가 현재 URL 세그먼트에 종속"이라는 점이다. `../../`로 change view 세그먼트를 거슬러 올라가 user-id 레벨을 벗어난 뒤 실제 `pk`를 다시 박으면, 접근 URL의 id 토큰이 pk든 to_field 값이든 결과 경로가 항상 동일한 pk 기반 password change URL로 고정된다. 특정 입력(uuid 예시)에 맞춘 하드코딩이 아니라 "id 토큰 비종속화"라는 근본 원인 제거다.
3. **regression 안전**: pk 기반 일반 접근(`.../user/<pk>/change/`)에서도 `../../<pk>/password/`가 동일 password change 페이지로 resolve되어야 하고, password help_text 렌더·`bug_19349_bound_password_field`·Admin/SetPassword 폼 동작(PASS_TO_PASS 86개)을 깨지 않아야 한다. 포맷 인자만 교체하므로 안전하다.
4. **함정 회피**: (a) 가장 큰 함정은 over-engineering — `../password/`를 `reverse("admin:..._password_change", ...)` 절대 URL로 바꾸려는 충동. 이러면 폼이 admin URLconf에 강결합되고 reverse가 admin 미설치/다른 namespace에서 깨진다. 골드는 의도적으로 "상대경로 + pk" 최소 조합만 유지한다. (b) 경로 단수 오류 — `../`/`../../../` 등 단계를 잘못 세는 off-by-one. admin URL이 `<id>/change/`라는 점을 정확히 알아야 `../../`가 맞다. (c) `self.instance.pk`가 None일 unbound 케이스를 과하게 방어하려는 충동 — 테스트는 바운드 인스턴스 기준이고 골드도 방어하지 않으므로, 최소 수정이 정답이며 과방어는 불필요한 분기다.
