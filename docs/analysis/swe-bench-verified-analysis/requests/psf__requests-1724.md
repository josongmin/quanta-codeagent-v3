---
instance_id: psf__requests-1724
repo: psf/requests
base_commit: 1ba83c47ce7b177efe90d5f51f7760680f72eda0
version: "2.0"
difficulty: "<15 min fix"
created_at: 2013-11-04T09:37:00Z
fail_to_pass: 6
pass_to_pass: 79
gold_files: [requests/sessions.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
Python 2.7에서 `requests.request(method=u'POST', ...)`처럼 HTTP 메서드를 unicode로 넘기면, multipart 파일 업로드 시 `httplib`이 `msg += message_body`(unicode + bytes)를 수행하며 `UnicodeDecodeError: 'ascii' codec can't decode byte ...`가 발생한다. 이슈 제출자는 `u'POST'`가 헤더를 unicode로 "감염"시킨다고 추정하며, 원인 라인으로 `sessions.py`의 `req.method = method.upper()`를 정확히 지목했다. 즉 method가 unicode면 `.upper()` 결과도 unicode로 남아 하위 스택에 전파된다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문이 원인 파일·라인(`sessions.py`, `method.upper()`)을 직접 지목하고 네이티브 스택트레이스까지 첨부. grep 한 방. 점수 L0.
- **S1 Direct-Map (+S2)**: 결함클래스가 정형적인 "타입 강제(coercion)" — unicode를 native `str`로 강제하면 끝나는 기계적 픽스다. 다만 Py2/Py3 동시 호환을 위해 `str` 직접 변환이 아니라 `compat`의 `builtin_str`을 써야 한다는 점에서 약한 제약추론(S2)이 보조로 붙는다.
- **K-Domain**: 일반 파이썬 지식만으론 Py2 `str` vs `unicode`/native-str 분기와 requests `compat` 레이어의 `builtin_str` 헬퍼 존재를 알아야 정답에 수렴. 프레임워크 내부 호환계층 지식이 병목 → K-Domain.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 "메서드를 native str로 강제"라는 기계적 매핑(S1)이라 T-DirectMap. APR 관점에서 PAR/TBar식 type-coercion 템플릿에 그대로 매칭된다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`requests/sessions.py`) · 실질 2줄(import 1줄 + 변환 1줄) · localize 직접성 최상(이슈가 라인 지목) · has-repro(네이티브 스택트레이스). 공식 라벨 "<15 min fix"와 일치. T1이 아닌 이유는 순수 K-Gen이 아니기 때문 — `str(method)`로 짜면 Py3에선 맞지만 Py2에서 `str`/`unicode` 호환 의도를 놓칠 수 있어 `builtin_str`이라는 도메인 헬퍼를 알아야 하고(K-Domain), 아래 검증 절의 P2P 폭(81개)이 약한 regression-trap을 형성한다. 그래서 T1이 아니라 T2.

## 골드패치 분석
- **파일·함수**: `requests/sessions.py` — `Session.request()` 진입부. 추가로 모듈 상단 import에 `builtin_str`를 `from .compat import ...`로 끌어온다.
- **근본원인**: `method`가 unicode(`u'POST'`)로 들어오면 `Request(method=method.upper())`에 unicode가 그대로 전달되고, 이 unicode method가 하위 `httplib`까지 흘러가 `message_body`(bytes)와의 문자열 연결 시 암묵적 ascii 디코딩을 유발 → 비-ascii body(multipart 파일)에서 `UnicodeDecodeError`.
- **수정요지**: `Request(...)` 생성 직전에 `method = builtin_str(method)`를 한 줄 삽입. unicode method를 진입점에서 native `str`로 정규화해 하류 전체로의 unicode 전파를 차단한다. `builtin_str`은 `compat`에서 Py2=`str`, Py3=`str`로 정의된 native-str 별칭이라 양 버전 호환.

## 검증 (test_patch)
- **추가 테스트**: `test_unicode_method_name` — `requests.request(method=u'POST', url=httpbin('post'), files=files)`로 unicode 메서드 + 파일 업로드를 재현하고 `r.status_code == 200`을 단언. 픽스 전엔 `UnicodeDecodeError`로 죽고, 후엔 method가 native str로 정규화되어 통과.
- **FAIL_TO_PASS/PASS_TO_PASS의 quirk**: 신규 `test_unicode_method_name` 자체는 PASS_TO_PASS 목록에 들어 있고, FAIL_TO_PASS 6개(`test_DIGEST_*`, `test_user_agent_transfers`, `test_uppercase_scheme_redirect`, `test_different_encodings_dont_break_post`, `test_generic_cookiejar_works`)는 직접 관련 없어 보이는 테스트들이다. 이는 requests의 라이브 httpbin 의존 테스트가 base 환경에서 불안정/순서민감하게 잡힌 SWE-bench 특유의 노이즈로, 핵심 증명은 신규 테스트가 담당한다.
- **overfit 관점**: `method = builtin_str(method)`는 특정 입력(`u'POST'`)이 아니라 모든 unicode/native 메서드를 일반화해 정규화하므로 special-case 통과가 아니다. overfit-risk 낮음.
- **regression 관점**: 이미 native str로 들어오던 기존 호출은 `builtin_str(str)` == 동일값이라 무영향. P2P 81개(HTTP verb 전반·redirect·cookie·auth)가 method 처리에 의존하므로 regression-trap은 존재하나, 변환이 idempotent라 안전.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스가 `msg += message_body`(httplib)에서 터지고, 제출자가 `sessions.py`의 `req.method = method.upper()`를 직접 지목 → `Session.request()`의 method 처리 경로로 즉시 수렴. 탐색 거의 불필요(L0).
2. **픽스와 일반화 근거**: `Request` 생성 전에 `method = builtin_str(method)` 삽입. unicode를 진입점에서 한 번 정규화하면 `.upper()` 이하 모든 하류가 native str을 받는다. `str(...)`이 아니라 `compat.builtin_str`을 쓰는 게 올바른 일반화 — Py2/Py3 양쪽에서 "그 버전의 native str"로 변환해 헤더/바디 인코딩 경계에서 ascii 암묵 디코딩을 막는다. 특정 메서드명이 아닌 타입 레벨 정규화라 overfit이 아니다.
3. **regression 안전**: P2P의 GET/PUT/HEAD/POST·redirect·digest auth 등은 모두 method를 native str로 넘기던 경로 → `builtin_str` 변환이 값 불변(idempotent)이라 깨지지 않음. import 추가도 기존 `compat` 심볼에 한 단어 덧붙임이라 부작용 없음.
4. **함정 회피**: (a) `req.method = method.upper()`를 `req.method = builtin_str(method.upper())`처럼 `.upper()` 결과만 감싸도 동작하지만, 오라클은 진입부에서 한 번 정규화해 method 변수 전체를 깨끗하게 만든다 — 더 일반적. (b) `str(method)`로 짜면 Py2에서 의도는 맞지만 프로젝트 호환 관례(`builtin_str`)를 어겨 코드리뷰/일관성에서 어긋남 — `compat` 헬퍼 존재를 모르면 여기서 미끄러진다. (c) FAIL_TO_PASS의 무관해 보이는 네트워크 테스트들을 "내 픽스가 깬 것"으로 오인해 엉뚱한 곳을 건드리는 함정 — 이들은 환경 노이즈이며 핵심 증명은 unicode method 테스트임을 인지해야 한다.
