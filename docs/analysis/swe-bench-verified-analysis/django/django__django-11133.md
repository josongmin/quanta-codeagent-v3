---
instance_id: django__django-11133
repo: django/django
base_commit: 879cc3da6249e920b8d54518a0ae06de835d7373
version: 3.0
difficulty: <15 min fix
created_at: 2019-03-27T06:48:09Z
fail_to_pass: 1
pass_to_pass: 64
gold_files: [django/http/response.py]
---

# django__django-11133

## 문제 요약
`HttpResponse`에 `memoryview` 객체를 content로 넣으면 본문이 깨진다. Postgres에서 `BinaryField`를 읽으면 `memoryview`가 반환되는데, `HttpResponse(memoryview(b"My Content")).content`가 실제 바이트(`b'My Content'`) 대신 `b'<memory at 0x...>'`처럼 객체의 repr 문자열을 바이트로 변환한 값을 돌려준다. 사용자는 `str`/`bytes`와 동일하게 원본 바이트가 그대로 들어가길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (edge-case / API-contract) — content 타입 분기에서 `memoryview` 미처리
- 서브시스템: django HTTP / `HttpResponseBase` 응답 본문 직렬화
- 증상 타입: silent-wrong (예외 없이 잘못된 본문 생성)
- 로컬라이제이션 신호: problem_statement가 `HttpResponse(...).content` 경로를 직접 지목; hints_text가 `HttpResponseBase.make_bytes`를 명시하고 `force_bytes`의 memoryview 지원(d680a3f4) 선례까지 언급해 수정 지점을 거의 못 박아준다.

## 골드패치 분석
- 건드린 파일/함수: `django/http/response.py` : `HttpResponseBase.make_bytes`
- 근본 원인: `make_bytes`는 `bytes` 분기와 `str` 분기를 우선 검사하는데, `memoryview`는 둘 다 아니므로 마지막 fallback(`str(value).encode(...)`)으로 떨어져 repr 문자열을 인코딩해버린다.
- 수정 요지: 바이트 분기 검사를 `isinstance(value, bytes)`에서 `isinstance(value, (bytes, memoryview))`로 넓혀, `memoryview`도 곧바로 `bytes(value)`로 캐스팅해 원본 버퍼를 그대로 직렬화하도록 했다. 한 줄 변경.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_memoryview_content (httpwrappers.tests.HttpResponseTests)`
- 증명 방식: `r = HttpResponse(memoryview(b'memoryview'))` 생성 후 `r.content == b'memoryview'`를 단언. 패치 전이면 content가 `b'<memory at ...>'`라 실패하고, 패치 후 `make_bytes`가 `bytes(memoryview)`로 변환해 통과한다. 기존 `test_non_string_content`/`test_iter_content` 등 64개 PASS_TO_PASS로 `bytes`/`str`/iterator 경로 무회귀를 보장.

## 공략 포인트 (뭘 조져야)
- localization 전략: `HttpResponse` content 세팅 흐름 → `content.setter` → `make_bytes`로 타고 내려가면 타입 분기가 한눈에 보인다. hints_text를 신뢰하면 바로 `make_bytes`로 직행 가능.
- 함정/난이도: 단일 파일·한 줄이라 난이도 낮음. 다만 `force_bytes`(utils/encoding)에 손대고 싶은 유혹이 있는데, 골드는 그 경로를 쓰지 않고 `make_bytes` 자체를 고친다(주석에 force_bytes를 안 쓰는 이유가 명시됨). `str` 분기 앞 순서를 지켜야 함.
- 우리 에이전트 관점: 막힐 위험은 거의 없으나, repr이 멀쩡한 바이트처럼 보여 "예외가 없으니 정상"으로 오판하거나, `force_bytes`/streaming 경로까지 과하게 건드려 PASS_TO_PASS 회귀를 낼 수 있다. 최소 수정(분기 튜플 확장)으로 수렴시키는 게 정답.
