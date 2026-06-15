---
instance_id: django__django-14155
repo: django/django
base_commit: 2f13c476abe4ba787b6cb71131818341911f43cc
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-03-19T15:44:25Z
fail_to_pass: 3
pass_to_pass: 89
gold_files: [django/urls/resolvers.py]
---

# django__django-14155

## 문제 요약
URL 뷰로 `functools.partial`을 넘기면 `ResolverMatch.__repr__()`가 func 인자를 그냥 `functools.partial`로만 출력해서, 감싸진 실제 함수나 미리 바인딩된 인자가 전혀 드러나지 않는다. partial은 앞단에 인자를 미리 갖고 있으므로, repr이 그 내부를 풀어서 보여주길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (edge-case) — partial 뷰라는 특수 케이스를 repr이 다루지 않음
- 서브시스템: django URL routing / resolvers (`django.urls.resolvers`)
- 증상 타입: silent-wrong (예외는 아니지만 디버깅에 쓸모없는 repr 출력)
- 로컬라이제이션 신호: 문제 제목/본문이 `ResolverMatch.__repr__()`를 명시적으로 지목 → `django/urls/resolvers.py`의 `ResolverMatch` 클래스로 바로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/urls/resolvers.py:ResolverMatch.__repr__`
- 근본 원인: `__repr__`이 항상 `self._func_path`를 사용하는데, partial 뷰는 `_func_path`가 의미 있는 함수 경로를 담지 못해 `functools.partial`류로만 표시되어 내부 함수·바인딩 인자가 사라짐.
- 수정 요지:
  - func이 `functools.partial` 인스턴스이면 `self._func_path` 대신 `repr(self.func)`를 사용해 partial 전체(감싼 함수 + 미리 바인딩된 인자)를 노출.
  - 일반 함수는 기존대로 `_func_path` 유지.
  - 동시에 format 스펙을 `%s`에서 `%r`로 바꿔 `args/kwargs/url_name/app_names/namespaces/route`를 repr 표현(따옴표 포함)으로 출력하도록 정비.
  - (참고) 문제 본문은 `__init__`에서 partial을 unwrap하자고 제안했지만, 골드는 `__repr__`에서만 분기 처리하는 최소 변경을 택함.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_repr`, `test_repr_functools_partial`, `test_resolver_match_on_request` (`urlpatterns_reverse.tests.ResolverMatchTests`)
- 증명 방식:
  - `test_repr`: 기존 repr 기대값을 `%r` 포맷에 맞춰 갱신 — `url_name=no-kwargs` → `url_name='no-kwargs'`, `route=^...$` → `route='^...$'` 처럼 따옴표가 붙는지 확인.
  - `test_repr_functools_partial`: `partial`, `partial_nested`, `partial_wrapped` URL을 resolve한 뒤, repr의 func 부분이 `functools.partial(<empty_view repr>, template_name='...')` 형태로 풀려 나오는지 subTest로 검증.

## 공략 포인트 (뭘 조져야)
- 어디부터: 문제 본문이 `ResolverMatch.__repr__`를 직접 호명하므로 localization은 쉬움 — `django/urls/resolvers.py`의 `ResolverMatch` 한 곳.
- 함정/난이도:
  - 본문 힌트("`__init__`에서 unwrap")를 곧이곧대로 따라가면 골드와 다른 구현이 되어 `args`/`func` 노출 기대값이 어긋날 수 있음. 골드는 repr 국소 수정으로 끝냄.
  - `%s` → `%r` 전환이 partial과 무관한 `test_repr` 기대값까지 바꿔야 함을 놓치기 쉬움(따옴표 누락). partial만 고치고 끝내면 `test_repr`가 깨진 채 남음.
  - `functools`가 모듈 상단에서 import되어 있는지 확인 필요(이미 import됨).
- 우리 에이전트 관점: repr 포맷 변경이 partial 케이스 외 기존 출력 형식까지 건드린다는 점을 함께 처리하지 못하면, 신규 테스트는 통과해도 `test_repr` 회귀로 부분 실패할 위험.
