---
instance_id: sphinx-doc__sphinx-8475
repo: sphinx-doc/sphinx
base_commit: 3ea1ec84cc610f7a9f4f6b354e264565254923ff
version: "3.4"
difficulty: "<15 min fix"
created_at: 2020-11-22T16:54:19Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [sphinx/builders/linkcheck.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [has-repro]
---

## 문제 요약
linkcheck 빌더는 깨진 링크를 빠르게 판별하려고 먼저 HEAD 요청을 보내고, HEAD가 실패하면(`HTTPError`) GET으로 폴백한다(#7936에서 HEAD 강제 도입). 그런데 일부 서버는 HEAD 요청에 대해 무한 리다이렉트 루프를 일으키며, 이때 requests가 던지는 예외는 `HTTPError`가 아니라 `TooManyRedirects`다. 현재 `except HTTPError`는 이 예외를 못 잡으므로 GET 폴백이 작동하지 않고 정상 링크가 broken으로 오보고된다. 이슈는 except 절을 `TooManyRedirects`까지 확장해 GET 재시도를 타게 해달라고 요청한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: 이슈가 "HEAD→GET 폴백 except 절"이라는 정확한 코드 지점을 지목한다. `linkcheck.py`의 `check_uri()` 안 try/except가 유일 후보 — grep 한 방.
- **S (Repair Strategy) = S1 (Direct-Map)**: 픽스가 사실상 이슈에 적혀 있다. except 튜플에 예외 타입 하나 추가하는 기계적 변경(결함클래스 = "잡아야 할 예외 누락"). 추론으로 식을 합성할 필요 없음.
- **K (Knowledge) = K-API**: 핵심은 "requests가 redirect-loop에서 던지는 예외가 무엇인가"라는 requests 라이브러리 API 계약 지식. `TooManyRedirects`가 `HTTPError`의 하위가 아니라 별개 예외임을 알아야 정확히 잡는다(`import`도 따로 필요). 일반 파이썬 추론(K-Gen)만으로는 어떤 예외명을 추가할지 결정 못 함.
- **Primary = T-DirectMap**: 위치가 명확하고(L0) 픽스가 기계적 가드/예외-추가(S1)다. 추론 합성(T-ConstraintReason)도 스펙 재구성(T-SpecInference)도 아니며, 이슈가 폴백 의도를 명시해 underspecified가 아님.
- **APR 관점**: 실패테스트 피드백 없이도 이슈 본문 + requests 예외 계층 지식만으로 정답이 결정되는 template-style 수리(PAR/TBar류 "catch-clause 확장" 패턴). 후보 다수도 아니고 overfit 위험도 낮아 G&V/CEGIS가 아니라 S1이 dominant.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일수 1 / 변경 2줄(import 한 줄 + except 절 한 줄) → ICLR 2024 컷에서 "1파일·소규모"는 최상위 solve 구간.
- localize 직접성: L0 — 이슈가 지점을 직접 지목.
- repro: `has-repro` — 이슈에 무한 리다이렉트 시나리오와 구체 URL이 있고, test_patch가 `InfiniteRedirectOnHeadHandler`로 명확히 재현. 가장 강한 easiness 신호.
- 도메인: requests 예외 계층(K-API) 지식이 약간 필요해 순수 K-Gen T1보다 한 단계 위.
- P2P trap: PASS_TO_PASS 17개가 linkcheck 동작 전반을 덮지만, except 절에 타입을 **추가**만 하므로 기존 `HTTPError` 경로는 그대로 — regression-trap 약함.
- 공식 라벨 "<15 min fix"와 일치(T1~T2 prior). T1이 아닌 이유: 예외명을 모르면 못 고치는 K-API 의존 때문에 "이슈가 픽스를 거의 적어주는" 완전 자명(T1)보다 살짝 위.

## 골드패치 분석
- **건드린 파일·함수**: `sphinx/builders/linkcheck.py` — 모듈 상단 import + `CheckExternalLinksBuilder.check_thread()` 내부 클로저 `check_uri()`의 HEAD 시도 try/except.
- **근본원인**: #7936에서 HEAD 요청을 강제하면서 HEAD 실패 폴백을 `except HTTPError`로만 막아두었다. requests는 redirect 한도 초과 시 `HTTPError`가 아닌 별도 예외 `requests.exceptions.TooManyRedirects`를 raise한다. 이 예외가 except에 안 걸려 GET 폴백 로직이 건너뛰어지고, 예외가 위로 전파돼 링크가 broken으로 분류된다.
- **수정요지**: (1) `from requests.exceptions import HTTPError`를 `HTTPError, TooManyRedirects`로 확장. (2) `except HTTPError:`를 `except (HTTPError, TooManyRedirects):`로 변경. 이로써 HEAD에서 리다이렉트 루프가 나도 동일한 GET 재시도 분기(주석: "retry with GET request if that fails, some servers don't like HEAD requests")로 흘러간다.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_TooManyRedirects_on_HEAD`: `do_HEAD`가 자기 자신(`http://localhost:7777/`)으로 302를 무한 반환해 requests에서 `TooManyRedirects`를 유발하고, `do_GET`은 200을 반환하는 핸들러를 띄운다. 빌드 후 `output.json`이 `{"status": "working", "code": 0, "info": ""}`이길 단언한다.
- **픽스 증명**: 패치 전엔 HEAD에서 `TooManyRedirects`가 except를 통과 못 해 링크가 broken(working 아님)으로 기록 → 단언 실패. 패치 후엔 except 튜플이 이를 잡아 GET 폴백이 200을 받아 working으로 기록 → 통과. except 절이 진짜 chokepoint임을 핸들러가 HEAD/GET을 분기 처리해 증명한다.
- **overfit 관점**: 픽스가 테스트 입력에 특화된 분기가 아니라 예외 타입 자체를 폴백 경로에 합류시키는 일반화이므로 overfit 아님. FAIL_TO_PASS가 1개로 얇지만 픽스 형태(예외 추가)가 special-case 통과를 만들 여지가 없어 `overfit-risk` 미표기.
- **regression 관점**: 기존 `HTTPError` 폴백·정상 HEAD·GET 경로(P2P의 `test_follows_redirects_on_HEAD/GET`, `test_defaults` 등 17개)는 except를 좁히는 게 아니라 넓히기만 해서 동작 불변. `regression-trap` 약함.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "HEAD requests returns Too Many Redirects" + "GET fallback is ignored as the exception is of type `TooManyRedirects`"가 직접 신호. `linkcheck.py`에서 HEAD 요청 + `raise_for_status()` 뒤의 `except HTTPError:` 블록을 찾으면 끝(L0). #7936 참조로 HEAD 강제 도입 위치를 재확인할 수 있다.
2. **픽스와 일반화 근거**: except를 `(HTTPError, TooManyRedirects)`로 확장하고 import를 맞춘다. 이게 올바른 일반화인 이유 — 폴백 의도는 "HEAD가 어떤 식으로든 실패하면 GET으로 재시도"인데, redirect-loop는 HEAD 특유의 실패이므로 정확히 폴백 대상이다. 특정 URL/응답을 하드코딩하는 게 아니라 예외 클래스를 폴백 트리거에 합류시키므로 모든 redirect-loop 서버에 일반화된다.
3. **regression 안전**: except를 **추가**만 하므로 기존 `HTTPError` 폴백(`test_raises_for_invalid_status` 등 4xx/5xx 동작)과 정상 redirect 추종(`test_follows_redirects_on_HEAD/GET`)을 안 건드린다. 모든 예외를 잡는 `except Exception`으로 넓히지 않는 게 핵심 — 그러면 진짜 broken 링크(연결 실패 등)까지 GET 재시도로 삼켜 P2P를 깬다.
4. **함정 회피**: (a) `TooManyRedirects`를 `HTTPError`의 하위로 오인해 "이미 잡힌다"고 판단하는 것 — 둘은 `RequestException` 아래 형제이므로 별도로 명시해야 한다. (b) import 누락으로 `NameError` 내기 — except에 타입만 추가하고 `from requests.exceptions import`를 안 고치면 런타임 에러. (c) over-broad catch(`except Exception` 또는 `except RequestException`)로 일반화 — 깨진 링크를 working으로 오분류해 regression 유발. 오라클의 정확한 2개 타입 튜플이 이 세 함정을 모두 피하는 형태다.
