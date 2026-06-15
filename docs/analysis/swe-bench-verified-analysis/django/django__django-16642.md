---
instance_id: django__django-16642
repo: django/django
base_commit: fbe850106b2e4b85f838219cb9e1df95fba6c164
version: 5.0
difficulty: <15 min fix
created_at: 2023-03-11T07:38:47Z
fail_to_pass: 1
pass_to_pass: 21
gold_files: [django/http/response.py]
---

# django__django-16642

## 문제 요약
`FileResponse`에 `test.html.Z`나 `test.html.br`처럼 압축 확장자로 끝나는 파일을 넘기면 Content-Type이 압축 인코딩에 맞지 않게 `text/html`로 잘못 설정된다. 사용자는 `.br`(Brotli), `.Z`(Unix compress) 같은 압축 파일도 `.gz`/`.bz2`/`.xz`처럼 압축에 대응하는 MIME 타입으로 추론되기를 기대했다. 핵심은 브라우저가 자동으로 압축을 풀지 않도록 압축 인코딩별 content type을 내려줘야 한다는 점이다.

## 유형 분류
- 버그 카테고리: 누락처리 (encoding→content_type 매핑 테이블에 일부 인코딩 누락)
- 서브시스템: django HTTP / `FileResponse` 응답 헤더 추론
- 증상 타입: silent-wrong (잘못된 Content-Type 출력, 예외 없음)
- 로컬라이제이션 신호: problem_statement가 "FileResponse"와 "Mime Type guessing"을 직접 지목 → `django/http/response.py`의 `FileResponse.set_headers`에서 `mimetypes.guess_type`이 돌려준 `encoding`을 content_type으로 매핑하는 dict가 유일한 후보.

## 골드패치 분석
- 건드린 파일/함수: `django/http/response.py` : `FileResponse.set_headers`
- 근본 원인: `set_headers`는 `mimetypes.guess_type`이 반환한 `encoding` 값을 키로 하는 dict로 압축 content type을 결정하는데, 이 dict에 `"bzip2"`, `"gzip"`, `"xz"`만 있고 `"br"`(Brotli)와 `"compress"`(.Z)가 빠져 있었다. 누락된 인코딩은 `.get(encoding, content_type)`의 기본값으로 떨어져 원래 추론된 `text/html`이 그대로 유지됐다.
- 수정 요지: 매핑 dict에 두 항목을 추가했다 — `"br": "application/x-brotli"`, `"compress": "application/x-compress"`. 이로써 `mimetypes`가 `.br`/`.Z`를 압축 인코딩으로 인식할 때 대응하는 압축 MIME 타입이 내려가, 브라우저가 자동 해제하지 않도록 한다. 로직 변경은 없고 룩업 테이블에 누락 키를 채운 순수 데이터 추가.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_compressed_response` — 압축 응답이 비압축 Content-Type으로 잘못 나가지 않는지 검사.
- 테스트가 어떻게 픽스를 증명하는지: `test_tuples`에 두 케이스 `(".tar.br", "application/x-brotli")`와 `(".tar.Z", "application/x-compress")`를 기존 `.gz`/`.bz2`/`.xz` 옆에 추가하고, 각 확장자 파일에 대한 `FileResponse`의 `Content-Type` 헤더가 기대 MIME과 일치하는지 `subTest`로 확인한다. 패치 전에는 이 두 케이스가 `text/html`을 반환해 실패, 패치 후 dict 매핑으로 압축 타입을 반환해 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `FileResponse` → `set_headers` → encoding 매핑 dict로 바로 직행. `grep "application/x-bzip"` 또는 `"application/gzip"`이면 단번에 그 dict를 찾는다.
- 함정/난이도 메모: `.br`/`.Z`가 실제로 `mimetypes.guess_type`에서 어떤 `encoding` 문자열로 나오는지 확인 필요 — 키가 `"br"`/`"compress"`(파이썬 `mimetypes`의 `encodings_map` 기준)이지 확장자 그대로가 아니다. content type 자체(`text/html`)를 건드리는 함정에 빠지면 안 되고, 인코딩 분기 dict만 손대야 한다. 단일 파일/단일 함수라 멀티파일 위험은 없음.
- 우리 에이전트 관점: 매핑 키를 `".br"`/`".Z"`(확장자) 또는 `"brotli"` 등으로 잘못 추측하면 테스트가 여전히 실패한다. `mimetypes` 모듈의 인코딩 명칭을 정확히 확인하는 것이 유일한 함정이고, 그 외엔 1줄급 데이터 추가라 난이도가 낮다.
