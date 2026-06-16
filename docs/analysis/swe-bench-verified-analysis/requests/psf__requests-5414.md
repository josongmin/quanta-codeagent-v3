---
instance_id: psf__requests-5414
repo: psf/requests
base_commit: 39d0fdd9096f7dceccbc8f82e1eda7dd64717a8e
version: "2.26"
difficulty: "<15 min fix"
created_at: 2020-04-05T16:52:04Z
fail_to_pass: 1
pass_to_pass: 130
gold_files: [requests/models.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`requests.get("http://.example.com")` 처럼 host가 `.`(또는 빈 라벨)으로 시작하는 URL을 보내면 IDNA 인코딩 단계에서 `UnicodeError: label empty or too long`가 그대로 새어나온다. 이슈는 이미 ASCII wildcard(`*`) 케이스를 `InvalidURL`로 막는 의도가 있었으니, `.`로 시작하는 빈 라벨도 동일하게 `InvalidURL('URL has an invalid label.')`로 변환되어야 한다고 명세한다. 즉 기대 동작이 이슈 본문에 직접 적혀 있다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 `requests/models.py`의 정확한 라인(`prepare_url`, L401 부근)을 링크로 지목. grep 한 방. 후보 단일.
- **S (Repair Strategy) = S1 (+S2)**: 기존 `elif host.startswith(u'*')` 가드에 `.`를 추가하는 기계적 확장 — 정형 결함클래스(입력 검증 가드 확장)에 템플릿 매칭이라 dominant는 S1. 단 "왜 `*`와 `.`만이고 일반 빈 라벨 전체(`..`, 중간 빈 라벨)는 아닌가"를 따져야 해 약한 S2(constraint reasoning) 보조.
- **K (Knowledge) = K-Domain**: IDNA 인코딩이 빈 라벨에서 `UnicodeError`를 던진다는 점, ASCII/non-ASCII host의 분기(`unicode_is_ascii`) 구조를 알아야 정확한 가드 위치를 잡는다. 프레임워크/표준 도메인 지식.
- **primary_type = T-DirectMap**: 위치 명확(L0) + S1 기계적 가드 추가. 이슈가 기대 예외·메시지까지 지정하므로 추론보다 직매핑이 본질.
- APR 관점: 이슈가 픽스 형태(같은 `InvalidURL`로 rethrow)를 사실상 명세하고 결함이 "누락된 입력 가드"라는 정형 패턴이므로 PAR/TBar식 템플릿(조건 분기에 case 추가)으로 직매핑된다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`requests/models.py`), 1줄 변경, localize 직접성 최상(L0, 이슈에 라인 링크), `has-repro`(2줄 재현 코드+정확한 스택 메시지). 도메인 지식은 IDNA 빈-라벨 동작 정도로 가볍다. 공식 라벨 `<15 min fix`(T1~T2 prior)와 일치. T1이 아니라 T2인 이유: 픽스가 단순 None가드가 아니라 기존 `startswith` 가드를 튜플 형태 `startswith((u'*', u'.'))`로 확장하는 것이고, "어느 분기(ASCII elif)에 넣어야 non-ASCII 경로를 안 망가뜨리는가"라는 분기 의미 판단이 한 겹 들어간다. 또 P2P 131개(`regression-trap`)로 인접 URL 준비 동작을 광범위하게 안 깨야 한다.

## 골드패치 분석
- **파일·함수**: `requests/models.py`의 `PreparedRequest.prepare_url(self, url, params)`.
- **근본 원인**: ASCII host 경로에서 wildcard만 거부(`elif host.startswith(u'*')`)하고 `.`로 시작하는 host(= 첫 라벨이 빈 문자열)는 통과시킨다. 그 host가 netloc 재구성 후 IDNA 인코딩될 때 `UnicodeError(label empty or too long)`가 raw로 던져져 `requests`의 계약(`InvalidURL`)을 위반.
- **수정 요지**: 단일 라인 변경 `elif host.startswith(u'*'):` → `elif host.startswith((u'*', u'.')):`. `str.startswith`가 튜플 인자를 OR로 받는 특성을 이용해 `*` 또는 `.`로 시작하는 ASCII host를 동일하게 `InvalidURL('URL has an invalid label.')`로 막는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_invalid_url[InvalidURL-http://.example.com]` — `pytest.raises(InvalidURL)` 안에서 `http://.example.com` 준비가 `InvalidURL`을 던지는지 확인. 패치 전엔 `UnicodeError`라 raises 매칭 실패(또는 다른 예외 누수), 패치 후 ASCII `.`-시작 가드가 `InvalidURL`을 던져 통과.
- **픽스 증명**: 테스트는 `http://.example.com`(`.`-시작)과 `http://*example.com`(`*`-시작) 둘을 `test_invalid_url` 파라미터로 추가. 두 케이스 모두 새 튜플 가드를 거치므로 픽스 동작을 직접 관찰.
- **overfit·regression 관점**: FAIL_TO_PASS가 1개로 얇지만(`overfit-risk` 소지), 가드가 "특정 문자열"이 아니라 "prefix 분류"라 `.example.com`/`*example.com` 일반 클래스를 덮어 special-case overfit은 아니다. P2P 131개에 `test_preparing_url`(정상 IDNA/IPv6/유니코드 host)·`test_preparing_bad_url[http://*...]`이 포함돼, ASCII elif에만 손대 non-ASCII IDNA 경로와 기존 wildcard 거부를 안 깨는지를 회귀로 보장.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `requests/models.py#L401` 라인을 직접 링크하고 스택이 `idna codec ... label empty`를 가리킨다 → `prepare_url`의 ASCII/non-ASCII host 분기로 직행. 기존 `elif host.startswith(u'*')`가 "ASCII host 중 거부 케이스"임을 읽으면 끝.
2. **픽스와 일반화 근거**: 같은 elif 가드에 `.`를 추가(`startswith((u'*', u'.'))`). 이것이 올바른 일반화인 이유 — 빈 첫 라벨(`.`-시작)은 IDNA가 항상 `UnicodeError`를 내는 구조적 결함 클래스이고, requests의 계약은 그걸 `InvalidURL`로 노출하는 것(이슈가 명시한 의도). 문자열 동등비교가 아닌 prefix 분류라 `.foo.com`, `.example.com` 전체를 커버.
3. **regression 안전**: non-ASCII host는 위쪽 `if not unicode_is_ascii(host)` 경로에서 이미 IDNA 시도→`UnicodeError`→`InvalidURL` 변환되므로 건드리지 않는다. ASCII elif에만 case를 더해, `test_preparing_url`의 정상 IDNA/IPv6/유니코드 host와 기존 `*` 거부(`test_preparing_bad_url`)를 모두 보존(P2P 131).
4. **함정 회피**: (a) `.`를 막으려고 일반 host 검증을 과하게 강화(예: 모든 `..`/중간 빈 라벨까지 정규식 검사)하면 정상 host나 IPv6를 잘못 거부해 P2P 회귀. 오라클은 prefix 1문자만 추가하는 최소 변경. (b) non-ASCII 경로나 netloc 재구성부에 가드를 넣으면 ASCII `.`-시작이 안 잡히거나 이중 처리. 올바른 위치는 ASCII elif. (c) `UnicodeError`를 잡아 rethrow하는 방식도 동작하지만 이슈가 가리킨 의도(사전 검증 가드)와 어긋나 메시지/계약이 어긋날 수 있다 — 기존 `*` 가드 패턴에 합류하는 것이 최소·일관 해법.
