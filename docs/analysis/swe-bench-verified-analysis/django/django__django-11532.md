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
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap, overfit-risk]
---

# django__django-11532

## 문제 요약
컴퓨터 호스트명이 유니코드(예: "正宗")로 설정돼 있고 이메일 인코딩이 non-unicode(iso-8859-1)일 때 `email.message()`가 `UnicodeEncodeError`로 크래시한다. `Message-ID` 헤더가 `make_msgid(domain=DNS_NAME)`로 만들어지는데 `DNS_NAME`이 non-ASCII 그대로 들어가, latin-1로 헤더를 인코딩하는 단계(`forbid_multi_line_headers` → `Header(val, encoding).encode()`)에서 ordinal not in range(256)로 터진다. 이슈 본문은 재현 코드와 정확한 traceback을 모두 제공하고, "django.core.mail.utils 또는 message가 도메인을 punycode로 변환하라"는 픽스 방향까지 명시한다.

## 유형 (정형화)
- **L (Localization) = L1 — Traceable.** 이슈가 traceback 풀스택을 제공해 `core/mail/message.py:260 make_msgid(domain=DNS_NAME)`을 직접 가리킨다. 다만 거기서 한 단계 더 들어가 `DNS_NAME`(`core/mail/utils.py`의 `CachedDnsName.get_fqdn()`)이 정규화 지점임을 따라가야 한다. grep 한 방(L0)은 아니고 짧은 추적이 필요해 L1.
- **S (Strategy) = S1 Direct-Map (+S6 Design-Refactor).** 결함클래스가 "non-ASCII 도메인 → IDNA 인코딩 누락"이라는 정형 패턴이고, 픽스는 기계적이다(`socket.getfqdn()`을 `domain.encode('idna').decode('ascii')`로 감싸기). 이슈 본문/hints가 사실상 픽스 diff를 적어줘 추론 합성(S2)이 아니라 템플릿 매칭이다. 다만 골드는 그 한 줄을 `django/utils/encoding.py`에 `punycode()` 헬퍼로 추출하고 코드베이스 5곳의 동일 IDNA 패턴을 DRY 통합하는 소규모 구조 변경을 동반하므로 보조 S6.
- **K (Knowledge) = K-Domain.** punycode/IDNA(`encode('idna')`), email 헤더 charset 인코딩, django의 `CachedDnsName` lazy 캐시, `make_msgid` 흐름 등 프레임워크·표준라이브러리 도메인 지식이 필요. 일반 파이썬 추론(K-Gen)만으론 "왜 latin-1 단계에서 터지고 IDNA가 답인지"를 못 짚는다.
- **Primary = T-DirectMap.** 위치가 명확하고 픽스가 기계적 변환(IDNA 정규화 삽입)이라 T-DirectMap이 dominant. S6 리팩터링은 정답성의 본질이 아니라 골드의 코드정리 스코프라서 T-DesignRefactor로 끌어올리지 않는다. K-Domain이 있으나 병목이 "지식 부재로 못 푼다" 수준은 아니어서 T-DomainBound도 아니다.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- **파일수 5 / 함수 다수**지만 의미상 단일 결함의 mechanical 전파다. 핵심 픽스는 `utils.py` 1~2줄이고 나머지 4파일은 같은 패턴의 헬퍼 추출(저위험 반복). 진짜 cross-file 조율(L3)이 아니라 동형 치환이라 파일수에 비례한 난이도 가산은 제한적.
- **has-repro**: traceback + 재현코드 + 픽스 방향까지 제공 → 강한 easiness 신호(해결률 ~87% 구간). 이게 T4로 못 올라가게 누른다.
- **L1 + S1**: localize가 짧고 픽스가 자명에 가까움.
- **K-Domain + regression-trap**으로 T2 아래로 못 내려간다: PASS_TO_PASS 148개(대부분 mail 백엔드 전수)를 안 깨야 하고, punycode 변환을 잘못된 시점(ASCII 도메인까지 무조건 idna 인코딩 등)에 넣으면 인접 동작이 깨진다.
- 공식 라벨 "15min-1hour"와 **일치**(T3 prior와 정합). 다만 공식 라벨은 "골드의 5파일 리팩터링까지 구현하는 개발자 시간"이고, 에이전트 관점 최소 그린은 1파일이라 실난이도는 라벨보다 약간 낮을 수도 있으나, gold_files 매칭·regression 안전을 포함하면 T3가 타당.

## 골드패치 분석
- **건드린 파일/함수:**
  - `django/utils/encoding.py`: 신규 `punycode(domain)` 헬퍼 추가 — `return domain.encode('idna').decode('ascii')`.
  - `django/core/mail/utils.py`: `CachedDnsName.get_fqdn()` — `self._fqdn = punycode(socket.getfqdn())`로 FQDN 생성 시점에 정규화 (**핵심 픽스**).
  - `django/core/mail/message.py`: `sanitize_address()`의 `try: domain.encode('ascii') except: domain = domain.encode('idna').decode('ascii')` 블록을 `domain = punycode(domain)`으로 단순화.
  - `django/core/validators.py`: `URLValidator.__call__`의 `netloc.encode('idna').decode('ascii')`, `EmailValidator.__call__`의 `domain_part.encode('idna').decode('ascii')`를 `punycode(...)`로 교체.
  - `django/utils/html.py`: `urlize`의 netloc 처리, `is_email_simple` 도메인 처리도 `punycode(...)`로 교체.
- **근본 원인:** FQDN(호스트명)이 non-ASCII일 때 `make_msgid(domain=DNS_NAME)`을 통해 그대로 `Message-ID` 헤더 값으로 흘러들어가고, `email.encoding='iso-8859-1'`이면 헤더 charset 인코딩 단계에서 latin-1 범위를 벗어나 `UnicodeEncodeError`. 즉 도메인을 ASCII-safe(Punycode `xn--`)로 정규화하지 않은 누락.
- **수정 요지:** `domain.encode('idna').decode('ascii')` 산재 패턴을 `utils/encoding.py:punycode()` 단일 헬퍼로 추출(DRY)하고, **FQDN이 생성·캐시되는 `get_fqdn()` 시점에 정규화**해 헤더로 들어가기 전에 ASCII로 만든다. 이로써 Message-ID뿐 아니라 동일 IDNA 변환을 쓰는 validators/html 경로까지 일관 처리.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_non_ascii_dns_non_unicode_email (mail.tests.MailTests)`.
- **동작/픽스 증명:** `@mock.patch('socket.getfqdn', return_value='漢字')`로 호스트명을 non-ASCII로 강제하고, `delattr(DNS_NAME, '_fqdn')`로 `CachedDnsName`의 lazy 캐시를 비운다(안 그러면 이전 ASCII FQDN이 캐시돼 mock이 안 먹음). 그 뒤 `encoding='iso-8859-1'`인 EmailMessage의 `email.message()['Message-ID']`가 `@xn--p8s937b>`를 포함하는지 단언. 픽스 전엔 `email.message()`에서 `UnicodeEncodeError` 크래시, 픽스 후엔 `get_fqdn()`이 `punycode('漢字')='xn--p8s937b'`를 반환해 ASCII Message-ID가 정상 생성됨을 증명.
- **overfit 관점:** FAIL_TO_PASS가 단 1개(`overfit-risk`)라 테스트는 "메일 Message-ID 경로"만 직접 검증한다. validators/html의 `punycode` 치환은 이 테스트로 커버되지 않으므로, 그쪽까지 고치는 건 "테스트가 강제하는 정답"이 아니라 골드의 일관성 결정. 에이전트가 utils.py만 고쳐도 FAIL_TO_PASS는 그린이지만 gold_files 5개와는 불일치.
- **regression 관점:** PASS_TO_PASS 148개가 4개 메일 백엔드(Locmem/File/Console/SMTP)의 send/idn_send/unicode/header 동작을 전수 커버(`regression-trap`). `punycode`가 ASCII 도메인도 무조건 idna 인코딩하면 기존 `test_idn_send`·`test_send_unicode` 등이 깨질 수 있는데, `encode('idna')`는 ASCII 도메인을 그대로 통과시키므로 안전. 패턴을 1:1 동형 치환했기에 회귀가 발생하지 않는다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 traceback이 `message.py:260 make_msgid(domain=DNS_NAME)` → `forbid_multi_line_headers` → `Header(val, encoding).encode()`에서 latin-1 인코딩 실패를 직접 보여준다. 범인은 헤더 인코더가 아니라 그 입력값 `DNS_NAME`. `DNS_NAME` 정의를 따라 `django/core/mail/utils.py`의 `CachedDnsName.get_fqdn()` = `socket.getfqdn()`(정규화 없음)에 도달 → 여기가 누락 지점.
2. **픽스와 올바른 일반화:** `get_fqdn()`에서 `socket.getfqdn()`을 IDNA 정규화로 감싼다. 이게 overfit이 아니라 올바른 일반화인 이유 — 문제의 본질은 "테스트의 iso-8859-1"이 아니라 "non-ASCII FQDN을 ASCII 헤더에 넣는 것" 자체이고, 정규화를 **값의 출처(FQDN 생성)**에서 하면 Message-ID뿐 아니라 그 FQDN을 쓰는 모든 하류 경로가 한 번에 옳아진다. 산재한 `encode('idna').decode('ascii')`를 `utils/encoding.py:punycode()` 헬퍼로 추출하는 것은 DRY이자 future regression 차단(한 곳만 고치면 됨).
3. **regression 안전:** PASS_TO_PASS의 `test_idn_send`(이미 ASCII/IDN 도메인 전송), `test_send_unicode`, `test_unicode_headers`, `sanitize_address` 계열을 안 깨야 한다. `encode('idna')`는 순수 ASCII 입력을 변형 없이 통과시키므로 기존 ASCII 호스트 경로는 byte-identical. `sanitize_address`/validators의 치환도 동작 동일한 1:1 헬퍼 추출이라 회귀 0.
4. **함정 회피:** (a) 오라클 없는 에이전트는 `delattr(DNS_NAME, '_fqdn')` 없이 테스트하면 `CachedDnsName` 캐시 때문에 mock이 안 먹어 "고쳤는데 여전히 실패"로 오판할 수 있다(테스트는 캐시 무효화를 명시). (b) 픽스 위치를 `message.py`의 헤더 인코딩(`forbid_multi_line_headers`)에 두면 증상은 가리지만 근본인 FQDN 정규화를 놓쳐 다른 경로에서 재발 — 출처에서 고쳐야 함. (c) `punycode` 헬퍼를 `utils/encoding.py`에 둘 때 `validators.py`/`html.py`가 이를 import하는데 순환 import가 안 생기는지 확인(encoding은 하위 유틸이라 안전). (d) FAIL_TO_PASS만 노려 utils.py 1줄로 그린을 내면 gold_files 5개 일관성과 불일치하므로, 동일 IDNA 패턴 5곳을 헬퍼로 통일하는 것이 정답 스코프.
