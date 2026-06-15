---
instance_id: django__django-14539
repo: django/django
base_commit: 6a5ef557f80a8eb6a758ebe99c8bb477ca47459e
version: 4.0
difficulty: <15 min fix
created_at: 2021-06-19T11:31:16Z
fail_to_pass: 2
pass_to_pass: 14
gold_files: [django/utils/html.py]
---

# django__django-14539

## 문제 요약
`urlize()`가 HTML 엔티티(`&lt`)가 들어간 URL 끝의 후행 구두점을 잘라낼 때 잘못된 글자 수만큼 잘라낸다. `urlize('Search for google.com/?q=1&lt! and see.')`에서 `lt`가 링크 밖으로 새서 `...&lt</a>lt!`처럼 `lt`가 중복 출력된다. 사용자는 `...&lt</a>!`로 후행 `!`만 trail로 빠지길 기대했다.

## 유형 분류
- 버그 카테고리: off-by-one (정확히는 escaped vs unescaped 길이 불일치로 인한 인덱스 오류)
- 서브시스템: django text utils — `django/utils/html.py`의 `urlize()` 내부 구두점 트리밍
- 증상 타입: 잘못된 출력 (silent-wrong, 예외 없음)
- 로컬라이제이션 신호: problem_statement가 `urlize()` 함수명과 "trailing punctuation", "html escaped string"을 직접 명시 → `utils/html.py`의 trim 로직으로 바로 연결

## 골드패치 분석
- 건드린 파일/함수: `django/utils/html.py` : `urlize()` 안의 내부 함수 `trim_punctuation()`
- 근본 원인: 후행 구두점은 `middle_unescaped = html.unescape(middle)`(엔티티 해제된 문자열)에서 `rstrip`으로 검출하는데, 실제 slice는 원본 `middle`(엔티티가 살아있는 문자열)에 적용했다. 길이가 서로 다르므로(`&lt`=3자가 unescape 후 `<`=1자) `len(stripped)`로 계산한 인덱스가 원본 `middle` 좌표계와 어긋나 트림 경계가 밀린다.
- 수정 요지: unescaped 기준으로 잘린 구두점 개수 `punctuation_count = len(middle_unescaped) - len(stripped)`를 구한 뒤, 원본 `middle`의 끝에서 그 개수만큼만 음수 인덱스로 잘라낸다. `trail = middle[-punctuation_count:] + trail`, `middle = middle[:-punctuation_count]`. unescaped 길이를 원본 인덱스에 섞어 쓰던 기존 `middle[len(stripped):]` / `middle[:len(stripped)-len(middle_unescaped)]` 계산을 폐기.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_urlize`(케이스 테이블에 새 항목 추가), `test_urlize_unchanged_inputs`
- 테스트가 어떻게 픽스를 증명하는지: `test_urlize`에 입력 `'Search for google.com/?q=1&lt! and see.'` → 기대 `'Search for <a href="http://google.com/?q=1%3C">google.com/?q=1&lt</a>! and see.'`를 추가. 버그 상태에서는 `</a>lt!`가 나와 실패, 픽스 후 `</a>!`로 후행 `!`만 분리되어 통과. `test_urlize_unchanged_inputs`는 trim이 입력을 손상시키지 않는 멱등/불변 케이스를 함께 잡는다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `django/utils/html.py`에서 `urlize` → 내부 `trim_punctuation` → `TRAILING_PUNCTUATION_CHARS`로 `rstrip`하는 블록. 후행 구두점 처리 분기 하나만 보면 된다.
- 함정/난이도 메모: 핵심은 "검출 좌표계(unescaped)와 slice 좌표계(원본 escaped)가 다르다"는 점. lead/middle/trail 세 변수 흐름이 헷갈리고, 같은 함수에 선행(lead) 구두점 처리 분기도 있어 엉뚱한 분기를 고치기 쉽다. 단일 파일·단일 분기라 멀티파일은 아님.
- 우리 에이전트 관점: 증상만 보고 `html.unescape`/`smart_urlquote` 쪽 인코딩 문제로 오진하기 쉽다. `len(stripped)`를 원본 인덱스로 쓰는 게 진짜 버그인데, escaped 문자열이 더 길다는 점을 놓치면 "엔티티가 1자가 아닐 때만 깨진다"는 조건을 못 잡아 재현/수정에 헛돈다. 음수-인덱스 리라이트가 깔끔한 정답.
