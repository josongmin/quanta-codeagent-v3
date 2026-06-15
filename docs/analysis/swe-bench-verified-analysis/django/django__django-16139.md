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
---

# django__django-16139

## 문제 요약
admin에서 다른 모델이 `to_field="uuid"` 같은 식으로 User를 참조하면, UserAdmin이 pk가 아니라 to_field 값으로 접근된다(`.../user/2222.../change/?_to_field=uuid`). 이때 `UserChangeForm`의 password 필드 help_text에 들어가는 비밀번호 변경 링크가 상대경로 `../password/`로 하드코딩돼 있어 잘못된 URL로 풀려 404가 난다. 사용자는 어느 URL 형태로 폼에 접근하든 password 변경 링크가 올바른 곳을 가리키길 기대한다.

## 유형 분류
- 버그 카테고리: edge-case (pk가 아닌 to_field 접근이라는 가정 위반) / 누락처리
- 서브시스템: django.contrib.auth forms + admin URL 라우팅
- 증상 타입: 잘못된 출력(깨진 링크) → 후속 404 (silent-wrong에 가까움, 폼 자체는 정상 렌더)
- 로컬라이제이션 신호: problem_statement가 `UserChangeForm`, `password.help_text.format("../password/")`를 코드까지 그대로 인용하고 심지어 수정안까지 제시 → `django/contrib/auth/forms.py`로 직행.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/auth/forms.py` : `UserChangeForm.__init__`
- 근본 원인: 상대경로 `../password/`는 URL이 `.../<pk>/change/` 형태일 때만 맞는다. to_field 접근 시 URL 세그먼트 구조가 달라져 상대경로 기준점이 어긋나 password 변경 페이지로 못 간다.
- 수정 요지: help_text 포맷 인자를 `"../password/"`에서 `f"../../{self.instance.pk}/password/"`로 바꿈. 한 단계 더 위로 올라간 뒤 인스턴스의 실제 pk를 명시해 password URL을 재구성하므로, 접근 URL이 pk든 to_field든 관계없이 항상 올바른(pk 기반) password change 경로를 가리킨다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_link_to_password_reset_in_helptext_via_to_field` (UserChangeFormTest)
- 증명 방식: `ROOT_URLCONF="auth_tests.urls_admin"`로 override한 뒤 `testclient` User로 `UserChangeForm` 생성 → help_text에서 `<a href="(.*?)">` 링크를 정규식으로 추출. 이 링크를 to_field(username) 기반 change URL(`reverse(... args=(user.username,))`)에 `urllib.parse.urljoin`으로 결합한 결과가, pk 기반의 정식 `..._password_change` URL(`args=(user.pk,)`)과 정확히 일치하는지 단언. 즉 to_field로 접근해도 상대 링크가 올바른 password change 페이지로 resolve됨을 보장.

## 공략 포인트 (뭘 조져야)
- localization: problem_statement에 파일·함수·라인이 거의 그대로 노출돼 있어 `UserChangeForm.__init__`의 `format("../password/")` 한 줄을 찾으면 끝. grep `help_text.format` 또는 `../password/`.
- 함정/난이도: 단일 파일, 단일 라인 수정이라 난도는 낮음. 다만 "왜 `../../{pk}/`인가"를 이해하려면 admin change URL 구조(`<pk>/change/` vs `<pk>/password/`)와 to_field 접근 시 경로 변화를 알아야 함. 그냥 `../password/`를 절대 admin reverse로 바꾸려 하면 form이 URLconf에 의존하게 돼 과설계가 됨 — 골드는 의도적으로 상대경로 + pk 조합만 유지.
- 우리 에이전트 관점: 막힐 지점은 거의 없음. 위험은 오히려 over-engineering(reverse() 호출 도입)이나 `self.instance.pk`가 None일 수 있는 미바운드 케이스를 과하게 방어하려는 것. 테스트는 바운드 인스턴스 기준이므로 골드의 최소 수정이 정답.
