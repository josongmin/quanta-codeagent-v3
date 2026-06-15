---
instance_id: django__django-10097
repo: django/django
base_commit: b9cf764be62e77b4777b3a75ec256f6209a57671
version: 2.2
difficulty: <15 min fix
created_at: 2018-06-26T23:30:51Z
fail_to_pass: 438
pass_to_pass: 1432
gold_files: [django/core/validators.py]
---

# django__django-10097

## 문제 요약
`core.validators.URLValidator`가 #20003 이후 user:pass 인증 정보를 가진 URL을 허용하는데, RFC 1738 §3.1이 요구하는 "user/password 필드 내의 `:`, `@`, `/`는 %-인코딩되어야 한다"를 강제하지 않는다. 그 결과 `http://foo/bar@example.com` 같은 잘못된 URL이 통과하고, 임의의 invalid URL에 `?m=foo@example.com` 같은 쿼리스트링을 붙이면 valid로 둔갑한다. 사용자는 이런 인코딩 안 된 특수문자가 든 authority 부분을 검증 실패로 거부하길 기대한다.

## 유형 분류
- 버그 카테고리: validation (정규식 over-permissive로 인한 false-accept)
- 서브시스템: django core validators (URLValidator 정규식)
- 증상 타입: silent-wrong (잘못된 URL을 valid로 통과시킴, 예외 미발생)
- 로컬라이제이션 신호: problem_statement가 `core.validators.URLValidator`를 명시하고 "user and password field", "validation regex"를 직접 언급 → `django/core/validators.py`의 URLValidator.regex 중 `user:pass authentication` 주석이 달린 그룹으로 바로 좁혀짐.

## 골드패치 분석
- 건드린 파일/함수: `django/core/validators.py` → `URLValidator.regex` (user:pass 인증 서브패턴)
- 근본 원인: 기존 패턴 `(?:\S+(?::\S*)?@)?`이 user/pass를 `\S+`(공백 아닌 모든 문자)로 매칭. `\S`는 `:`, `@`, `/`를 포함하므로 인코딩 안 된 이 문자들이 user/pass에 들어가도 통과. 게다가 탐욕적 매칭이라 `?m=foo@example.com`처럼 경로/쿼리에 등장하는 `@`까지 authority로 빨아들여 invalid URL을 valid로 만든다.
- 수정 요지: user/pass 문자 클래스를 `\S`에서 `[^\s:@/]`로 교체. 즉 `(?:[^\s:@/]+(?::[^\s:@/]*)?@)?`. 이제 user와 pass 각 필드는 공백·`:`·`@`·`/`를 직접 포함할 수 없고(반드시 %-인코딩), 구분자 역할의 `:`(user:pass)와 종료 `@`만 리터럴로 허용된다. 한 줄 변경으로 RFC 1738 §3.1 준수.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `tests/validators/invalid_urls.txt`에 6개 케이스 추가 — `http://foo@bar@example.com`, `http://foo/bar@example.com`, `http://foo:bar:baz@example.com`, `http://foo:bar@baz@example.com`, `http://foo:bar/baz@example.com`, `http://invalid-.com/?m=foo@example.com`. 모두 거부되어야 함. (FAIL_TO_PASS가 438개로 큰 것은 `tests.test_validators`가 fixture 파일 전체를 데이터-드리븐으로 한 테스트씩 도는 구조라 카운트가 부풀려진 것이지 변경 범위가 넓은 게 아님.)
- 테스트가 어떻게 픽스를 증명하는지: invalid 파일의 새 케이스들은 user/pass에 인코딩 안 된 `:`,`@`,`/`를 끼워 넣은 형태라 새 문자 클래스에서 매칭 실패 → ValidationError 기대(픽스 없으면 통과해 실패). 동시에 `valid_urls.txt`의 회귀 케이스를 `http://-.~_!$&'()*+,;=:%40:80%2f::::::@example.com`에서 `http://-.~_!$&'()*+,;=%40:80%2f@example.com`로 수정 — 기존 valid 케이스가 비현실적으로 인코딩 안 된 `:`/`@`를 남발했던 것을 RFC 준수 형태로 정정해, 픽스가 정당한 인코딩된 user:pass는 계속 허용함을 증명.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement에 클래스명·파일경로가 사실상 다 적혀 있어 localization은 trivial. `django/core/validators.py`의 `URLValidator.regex` 안에서 `# user:pass authentication` 주석이 달린 라인 단 하나가 타겟.
- 함정/난이도 메모: 단일 파일·단일 라인 정규식 패치라 멀티파일 아님. 진짜 난이도는 "정확한 문자 클래스 선택"에 있다 — `\S`를 너무 좁히면(`[a-z0-9]` 등) 정당한 %-인코딩·special char user/pass를 깨서 valid_urls 회귀를 유발, 너무 넓히면 버그 잔존. 골드의 `[^\s:@/]`는 "공백/구분자/경로구분자만 배제"라는 최소 변경이며, pass 그룹은 `*`(빈 비번 허용)로 유지해야 함에 주의.
- 우리 에이전트 관점: 막힐 만한 지점은 (1) test_patch가 fixture 텍스트 파일이라 코드 테스트가 아님 → 어떤 케이스가 추가됐는지 못 보면 어느 문자를 막아야 할지 못 잡음, (2) 탐욕적 매칭 때문에 `?m=foo@example.com` 케이스가 통과하는 메커니즘(경로의 `@`가 authority로 흡수됨)을 이해 못 하면 부분 픽스에 그칠 수 있음, (3) valid_urls fixture를 함께 손보지 않으면 기존 비현실 케이스 때문에 PASS_TO_PASS 회귀가 나는데, 에이전트가 valid 파일까지 정정해야 함을 놓치기 쉬움(골드도 valid 파일을 수정했지만 이는 test_patch에 포함, 즉 제품 코드는 정규식 한 줄로 충분).
