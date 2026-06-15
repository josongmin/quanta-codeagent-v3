---
instance_id: django__django-11532
repo: django/django
base_commit: a5308514fb4bc5086c9a16a8a24a945eeebb073c
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-07-02T10:29:28Z
fail_to_pass: 1
pass_to_pass: 148
gold_files: [django/core/mail/message.py, django/core/mail/utils.py, django/core/validators.py, django/utils/encoding.py, django/utils/html.py]
---

# django__django-11532

## 문제 요약
컴퓨터 호스트명이 유니코드(예: "正宗")로 설정돼 있고 이메일 인코딩이 non-unicode(iso-8859-1)일 때 `email.message()`가 `UnicodeEncodeError`로 크래시한다. `Message-ID` 헤더가 `make_msgid(domain=DNS_NAME)`로 만들어지는데 DNS_NAME이 non-ASCII 그대로 들어가, latin-1로 헤더 인코딩하는 단계에서 터진다. 사용자는 Django가 도메인을 punycode로 변환해서 ASCII로 안전하게 처리하길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (edge-case) — non-ASCII 도메인 정규화 누락
- 서브시스템: django core mail (메시지 생성/헤더 인코딩), 부수적으로 validators/utils.html
- 증상 타입: 예외 (UnicodeEncodeError 크래시)
- 로컬라이제이션 신호: traceback이 `django/core/mail/message.py:260`의 `make_msgid(domain=DNS_NAME)`와 `forbid_multi_line_headers`를 직접 가리킴. DNS_NAME은 `django/core/mail/utils.py`의 `CachedDnsName.get_fqdn()`에서 나온다 → utils가 정규화 지점.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/utils/encoding.py`: 신규 `punycode(domain)` 헬퍼 추가
  - `django/core/mail/utils.py`: `CachedDnsName.get_fqdn()` — `socket.getfqdn()`를 `punycode(...)`로 감쌈
  - `django/core/mail/message.py`: `sanitize_address()` 도메인 처리를 `punycode(domain)`로 교체
  - `django/core/validators.py`: `URLValidator.__call__`, `EmailValidator.__call__`의 `encode('idna')` 중복을 `punycode`로 교체
  - `django/utils/html.py`: `urlize`(unquote_quote 부근), `is_email_simple` 도메인 처리도 `punycode`로 교체
- 근본 원인: FQDN(호스트명)이 non-ASCII일 때 그대로 `Message-ID` 도메인으로 흘러들어가, iso-8859-1 헤더 인코딩 단계에서 ASCII/latin-1 범위를 벗어나 인코딩 불가.
- 수정 요지: `domain.encode('idna').decode('ascii')` 패턴을 단일 `punycode()` 헬퍼로 추출하고, FQDN 생성 시점(`get_fqdn`)에서 punycode로 정규화해 헤더로 들어가기 전에 ASCII(`xn--...`)로 만든다. 동시에 코드베이스 전반에 흩어진 동일 IDNA 변환 로직을 헬퍼로 DRY 통합.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_non_ascii_dns_non_unicode_email (mail.tests.MailTests)`
- 테스트가 어떻게 픽스를 증명하는지: `socket.getfqdn`을 `'漢字'`로 mock하고 `DNS_NAME`의 캐시(`_fqdn`)를 `delattr`로 비운 뒤, `encoding='iso-8859-1'`인 EmailMessage의 `email.message()['Message-ID']`가 `@xn--p8s937b>`를 포함하는지 단언. 즉 non-ASCII FQDN이 punycode로 변환돼 크래시 없이 ASCII Message-ID가 만들어짐을 확인.

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback의 `make_msgid(domain=DNS_NAME)` → DNS_NAME 정의(`core/mail/utils.py CachedDnsName.get_fqdn`)를 따라가면 정규화 누락 지점이 바로 드러난다. 핵심 최소 픽스는 utils.py 한 곳.
- 함정/난이도 메모: hints의 최소 diff는 utils.py만 고치지만, 골드는 `encode('idna').decode('ascii')` 패턴 5곳을 `punycode` 헬퍼로 리팩터링한다. FAIL_TO_PASS 통과만 보면 utils.py 한 줄이면 충분하지만, 골드 파일 매칭/일관성 관점에선 헬퍼 추출이 정답. `_fqdn` 캐시 때문에 테스트가 `delattr` 해야 동작하는 점도 함정.
- 우리 에이전트 관점: 최소 픽스(utils.py)와 골드의 리팩터링 범위(5파일) 사이에서 스코프를 어디까지 넓힐지가 갈림. FAIL_TO_PASS만 노리면 1파일 픽스로 그린이지만 gold_files 5개와 불일치. punycode를 `utils/encoding.py`에 두고 import 순환(validators/html이 encoding을 import)이 안 생기는지도 확인 필요.
