---
instance_id: psf__requests-1766
repo: psf/requests
base_commit: 847735553aeda6e6633f2b32e14ba14ba86887a4
version: "2.0"
difficulty: "<15 min fix"
created_at: 2013-11-29T08:38:09Z
fail_to_pass: 6
pass_to_pass: 79
gold_files: [requests/auth.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
RFC2617에 따르면 Digest 인증 헤더의 `qop-options` directive 값은 큰따옴표로 감싼 quoted-string이어야 한다(`qop="auth"`). requests는 이를 따옴표 없이 `qop=auth`로 내보내고 있었다. curl도 따옴표를 붙이며, 일부 엄격한 서버 구현은 이 차이에 민감해 인증에 실패한다. 즉 Authorization 헤더를 RFC2617 준수 형태로 고치는 문제다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문이 "qop-options를 큰따옴표로 quote"라고 RFC 인용까지 곁들여 명시. `requests/auth.py`의 `HTTPDigestAuth.build_digest_header`에서 `qop=auth` 문자열 리터럴 한 곳을 grep으로 즉시 지목 가능. 탐색 비용 사실상 0.
- **S1 (Direct-Map)**: 이슈가 픽스를 사실상 명세한다. `qop=auth` → `qop="auth"` 상수 문자열 변경 1줄. 식·조건 추론 없음. 정형 결함클래스(프로토콜 포맷 상수)에 템플릿 매칭.
- **K-Domain**: 일반 파이썬 추론은 아니고 HTTP Digest Auth/RFC2617 헤더 문법 지식이 필요. 다만 이슈가 RFC를 직접 인용하므로 모델빨 의존도는 낮춰진다. K-Gen에 가깝지만 "왜 따옴표가 옳은가"의 근거가 프로토콜 스펙이라 K-Domain으로 둔다.
- **primary = T-DirectMap**: 위치 명확(L0) + 기계적 상수 수정(S1). 추론 합성(S2)이나 스펙 재구성(S5) 불필요 — 이슈가 정답 토큰을 그대로 적어줌. APR 관점에서 PAR/TBar류 패턴(상수 교정) 그대로.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일(`requests/auth.py`)·실효 변경 1줄(다른 헌크는 trailing-whitespace 정리)·localize 직접성 최상(L0)·이슈에 RFC 인용 = `has-repro`에 준하는 강한 easiness 신호. 도메인은 RFC 한 줄로 압축되어 병목 아님. P2P trap은 81개로 수치상 넓어 보이나 대부분 무관한 회귀 가드(쿠키/인코딩/헤더 dict)라 실질 위험 낮음. 공식 라벨 "<15 min fix"와 일치(T1~T2 구간). T1로 내리지 않은 이유: 픽스 자체는 자명하나 `qop="auth"`의 정당성이 프로토콜 스펙에 근거(순수 K-Gen 한 줄 가드보다 한 단계 위).

## 골드패치 분석
- **건드린 파일·함수**: `requests/auth.py` — `HTTPDigestAuth.build_digest_header` 내부(`sha_utf8` 정의 아래 블록).
- **근본원인**: Authorization 헤더 조립 시 `base += ', qop=auth, nc=%s, cnonce="%s"'`로 `qop` 값을 bare token으로 출력. RFC2617은 quoted-string을 요구하므로 비준수.
- **수정요지**: 해당 라인을 `', qop="auth", nc=%s, cnonce="%s"'`로 변경해 `qop` 값을 큰따옴표로 감쌈. 나머지 헌크(`A2` 위 trailing space, 한 줄)는 동작 무관한 공백 정리.

## 검증 (test_patch)
- **신규 FAIL_TO_PASS**: `test_DIGESTAUTH_QUOTES_QOP_VALUE` — `HTTPDigestAuth('user','pass')`로 `digest-auth` 엔드포인트에 GET 후, `r.request.headers['Authorization']`에 `'"auth"'`(따옴표 포함 문자열)가 들어있는지 단언. 픽스 전엔 `qop=auth`라 `"auth"` 부분문자열이 없어 실패, 픽스 후 `qop="auth"`로 통과.
- **나머지 FAIL_TO_PASS 5개**(`test_HTTP_200_OK_GET_ALTERNATIVE`, `test_cookie_sent_on_redirect`, `test_custom_content_type`, `test_params_are_merged_case_sensitive`, `test_user_agent_transfers`)는 qop와 무관 — test_patch가 같은 파일에 들어가며 SWE-bench 수집 시 동봉된 동작 테스트로, 환경 정상성 회귀 게이트 역할.
- **overfit 관점**: 단언이 `'"auth"' in header`로 substring만 검사 → 이론상 다른 곳에 `"auth"`를 끼워넣는 special-case로도 통과 가능(약한 overfit 여지). 그러나 정답 패치는 상수 1개 교정이라 일반화가 자명하고 다른 우회 경로의 ROI가 없다. 실질 overfit 위험 무시 가능.
- **regression 관점**: P2P 81개 중 Digest 인접(`test_DIGESTAUTH_WRONG_HTTP_401_GET`, `test_DIGEST_AUTH_RETURNS_COOKIE`, `test_DIGEST_STREAM` 등)이 헤더 포맷 변경에 민감. `nc`/`cnonce`/`response` 등 다른 directive를 건드리지 않으므로 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 키워드 `qop` → 레포 전역 grep. `requests/auth.py`의 `build_digest_header`에서 `'qop=auth'` 리터럴 단일 히트. 추가 탐색 불필요(L0).
2. **픽스**: 그 라인의 `qop=auth`를 `qop="auth"`로 변경. RFC2617이 `qop-options`를 quoted-string으로 규정하므로 이는 special-case가 아닌 프로토콜 준수의 올바른 일반화 — 모든 Digest 요청에 동일하게 적용되며, curl 등 레퍼런스 구현과도 일치.
3. **regression 안전**: `nc=%s`(nc는 quoted 아님이 RFC상 옳음)·`cnonce`·`response` 등 다른 directive의 quoting을 건드리지 않는다. 이걸 함께 quote하면 인접 Digest P2P가 깨진다. 변경 범위를 `qop` 값 한 곳으로 한정해야 함.
4. **함정 회피**: (a) `qop` 토큰 자체나 등호를 바꾸지 말 것 — 값만 quote. (b) `nc`까지 따옴표로 감싸는 과잉수정 금지(RFC상 nc는 unquoted). (c) trailing-whitespace 헌크에 현혹돼 실효 변경을 놓치지 말 것 — 본질은 line 144 한 줄. 오라클 없는 에이전트는 "qop이면 다 quote" 식으로 nc/cnonce까지 건드리는 과교정에서 틀리기 쉽다.
