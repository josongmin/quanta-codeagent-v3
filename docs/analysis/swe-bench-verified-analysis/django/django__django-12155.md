---
instance_id: django__django-12155
repo: django/django
base_commit: e8fcdaad5c428878d0a5d6ba820d957013f75595
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-11-28T16:24:23Z
fail_to_pass: 1
pass_to_pass: 6
gold_files: [django/contrib/admindocs/utils.py, django/contrib/admindocs/views.py]
---

# django__django-12155

## 문제 요약
admindocs가 view/model docstring을 렌더링할 때, 첫 줄이 비어있지 않은(텍스트가 첫 줄부터 시작하는) docstring을 만나면 docutils가 `Error in "default-role" directive: no content permitted.` 에러를 낸다. Django 자체 docstring은 전부 첫 줄이 빈 형식이라 정상 동작하지만, 일반적인 `"""test tests something.\n"""` 형태는 깨진다. 사용자는 첫 줄부터 텍스트가 있어도 정상 렌더링되길 기대한다.

## 유형 분류
- 버그 카테고리: edge-case (들여쓰기 계산 시 첫 줄 indent=0 미처리)
- 서브시스템: django contrib admindocs (docstring 파싱/RST 렌더링)
- 증상 타입: 잘못된 출력 / docutils 렌더 에러 (default-role 디렉티브 깨짐)
- 로컬라이제이션 신호: problem_statement가 범인 코드를 직접 지목한다 — `trim_docstring`의 `indent = min(len(line) - len(line.lstrip()) for line in lines if line.lstrip())`. "first line indentation is 0"이 핵심 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admindocs/utils.py:trim_docstring`(삭제) 및 `parse_docstring`, `django/contrib/admindocs/views.py:ViewDetailView.get_context_data`
- 근본 원인: `trim_docstring`은 `lines` 전체에서 최소 indent를 계산하는데, 첫 줄은 보통 indent가 0이라 min이 항상 0이 된다. 그러면 나머지 줄의 공통 들여쓰기가 제거되지 않아 본문 첫 줄에 leading whitespace가 남고, docutils의 default-role 디렉티브가 그 잔여 들여쓰기를 content로 오인해 에러를 낸다.
- 수정 요지: 직접 짠 `trim_docstring` 함수를 통째로 제거하고 표준 라이브러리 `inspect.cleandoc`로 교체. PEP 257 indent 처리 알고리즘을 정확히 구현한 cleandoc가 첫 줄을 올바르게 특수 취급한다. `parse_docstring`은 빈 docstring일 때 `'', '', {}`를 early-return한 뒤 `cleandoc(docstring)` 호출. `views.py`도 `utils.trim_docstring(verbose)` 호출을 `cleandoc(verbose)`로 바꿈. hints의 `lines[1:]` + `default=0` 미봉책 대신 검증된 표준 함수 채택.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_parse_rst_with_docstring_no_leading_line_feed` — 첫 줄에 바로 텍스트가 오는 docstring(`'firstline\n\n    second line'`)을 parse_docstring → parse_rst로 흘려도 에러 없이 렌더되는지 확인.
- 테스트가 픽스를 증명하는 방식: `parse_docstring('firstline\n\n    second line')`의 title/body를 각각 `parse_rst`로 렌더해 `'<p>firstline</p>\n'`, `'<p>second line</p>\n'`이 나오는지 단언하고, 결정적으로 `captured_stderr()`로 stderr를 잡아 `stderr.getvalue() == ''`를 검사한다. 버그 상태에선 docutils가 default-role 에러를 stderr로 토해내므로 이 단언이 깨진다. 기존 `test_trim_docstring`과 `trim_docstring` import는 함수가 사라졌으므로 삭제.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 함수명(`trim_docstring`)과 결함 라인이 명시되어 있어 위치 찾기는 쉽다. `django/contrib/admindocs/utils.py`로 직행.
- 함정/난이도 메모: (1) 단순히 `lines[1:]`로 슬라이스하면 hints가 경고한 `ValueError: min() arg is an empty sequence`(빈 sequence) 회귀가 생긴다 — 골드는 이를 피하려고 함수를 아예 cleandoc로 대체. (2) 멀티파일이다 — `trim_docstring`을 지우면 `views.py`의 호출부도 같이 고쳐야 import 깨짐을 막는다. (3) `parse_docstring`의 빈 docstring 가드(`if not docstring: return '', '', {}`)를 빠뜨리면 cleandoc(None)에서 터질 수 있다.
- 우리 에이전트 관점: min-indent를 `lines[1:]`로 패치하는 "최소 수정"으로 만족하기 쉬운데, 그러면 default 처리 누락으로 다른 테스트가 깨진다. 검증된 표준(cleandoc) 채택 + 호출부 동기 수정 + 빈 입력 가드까지 3박자를 다 맞춰야 PASS_TO_PASS(6개)가 유지된다. 함수 삭제에 따른 import/테스트 정리까지 트리 전체를 봐야 하는 점이 막힐 지점.
