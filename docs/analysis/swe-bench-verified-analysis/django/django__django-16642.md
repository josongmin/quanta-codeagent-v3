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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro]
---

# django__django-16642

## 문제 요약
`FileResponse`에 `test.html.Z`나 `test.html.br`처럼 압축 확장자로 끝나는 파일을 넘기면 Content-Type이 압축 인코딩에 맞지 않게 `text/html`로 잘못 설정된다. problem_statement는 재현 코드 2줄(`FileResponse(open('test.html.Z', 'rb'))`, `FileResponse(open('test.html.br', 'rb'))`)을 직접 제공한다. 사용자는 `.br`(Brotli)·`.Z`(Unix compress) 같은 압축 파일도 `.gz`/`.bz2`/`.xz`처럼 압축 인코딩에 대응하는 MIME 타입으로 추론되기를 기대했다. 핵심은 브라우저가 응답을 자동으로 압축 해제하지 않도록 압축 인코딩별 content type을 내려줘야 한다는 점이다.

## 유형 (정형화)
- **L0 (Localization)** — problem_statement가 `FileResponse`와 "Mime Type guessing"을 직접 지목하고 재현 코드까지 준다. `django/http/response.py`의 `FileResponse.set_headers` 안의 인코딩→content_type 매핑 dict가 유일한 후보이며, `grep "application/gzip"` 또는 `"application/x-bzip"` 한 방으로 정확히 그 dict에 착지한다. 탐색 비용 사실상 0 → L0.
- **S1 Direct-Map (+S2)** — 정형 결함클래스(룩업 테이블 누락 키 채우기)에 템플릿 매칭된다. 픽스는 기존 `"bzip2"`/`"gzip"`/`"xz"` 엔트리와 동일 패턴으로 `"br"`/`"compress"` 두 키를 추가하는 순수 데이터 변경이며 로직 분기 신설이 없다 → dominant S1. 보조 S2가 붙는 이유는, *어떤* 키 문자열을 쓸지가 자명하지 않기 때문이다. 확장자(`.br`/`.Z`)가 아니라 파이썬 `mimetypes` 모듈이 `encodings_map`에서 반환하는 인코딩 명칭(`"br"`, `"compress"`)이어야 하고, MIME 값(`application/x-brotli`, `application/x-compress`)도 IANA/관례에 맞춰야 한다. 즉 "기계적 추가"이되 키·값을 도메인 계약에서 추론(constraint reasoning)해 합성해야 하므로 S1+S2.
- **K-Domain (Knowledge)** — 일반 파이썬 추론만으론 `mimetypes.guess_type`이 `.Z`를 `encoding="compress"`로, `.br`을 `encoding="br"`로 돌려준다는 사실을 모른다. django/CPython 표준라이브러리 내부지식이 키 선택의 병목 → K-Domain.
- **primary type: T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적인 룩업 테이블 보강(S1)이라는 점이 dominant. K-Domain이 키 문자열에 영향을 주지만 그것이 *지배적 난점*은 아니므로 T-DomainBound이 아니라 T-DirectMap이 정확하다.

## 난이도 티어
**T2 (쉬움).** 구조적 피처: 단일 파일(`gold_files=[django/http/response.py]`)·단일 함수(`set_headers`)·실효 +2줄, has-repro(재현 코드 직접 제공 — 가장 강한 easiness 신호), L0 직접 localize. 이 모든 게 T1~T2 구간을 가리킨다. T1(존나쉬움)이 아니라 T2인 이유는 순수 S1/K-Gen이 아니기 때문이다 — 픽스가 자명한 한 줄이 아니라 `mimetypes` 인코딩 명칭(`"compress"`/`"br"`)과 IANA MIME 값을 정확히 골라야 하는 가벼운 K-Domain 엣지추론(S2 보조)이 끼어 있고, 키를 확장자로 잘못 추측하면 테스트가 그대로 빨개진다. regression-trap은 약하다(P2P 21개지만 전부 `FileResponse` 헤더 동작이고 `.get(encoding, content_type)` 기본값 경로를 건드리지 않아 기존 케이스에 영향 없음). 공식 라벨 `<15 min fix`(T1 prior)와 본 분석 T2의 차이는 작으며, 키 추론에 필요한 도메인 지식 한 줌만큼 위로 보정한 것이다.

## 골드패치 분석
- **건드린 파일·함수:** `django/http/response.py` → `FileResponse.set_headers(self, filelike)`
- **근본 원인:** `set_headers`는 `mimetypes.guess_type`이 반환한 `encoding` 값을 키로 하는 dict로 압축 content type을 결정한다. 이 dict에는 `"bzip2"`, `"gzip"`, `"xz"`만 있었고 `"br"`(Brotli)와 `"compress"`(.Z, Unix compress)가 빠져 있었다. 누락된 인코딩은 `.get(encoding, content_type)`의 기본값으로 흘러, 원래 추론된 `text/html`(또는 파일 본문 타입)이 그대로 유지됐다 — silent-wrong.
- **수정 요지:** 매핑 dict에 두 항목 추가 — `"br": "application/x-brotli"`, `"compress": "application/x-compress"`. 이로써 `mimetypes`가 `.br`/`.Z`를 압축 인코딩으로 인식할 때 대응 압축 MIME이 내려가 브라우저가 자동 해제하지 않는다. 로직 변경 없이 룩업 테이블 누락 키를 기존 패턴 그대로 채운 데이터 추가.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_compressed_response` ("If compressed responses are served with the uncompressed Content-Type ..." docstring) — 압축 응답이 비압축 Content-Type으로 잘못 나가지 않는지 검사.
- **픽스 증명:** `test_tuples`에 `(".tar.br", "application/x-brotli")`와 `(".tar.Z", "application/x-compress")`를 기존 `.gz`/`.bz2`/`.xz` 옆에 추가하고, 각 확장자 파일에 대한 `FileResponse`의 `Content-Type` 헤더가 기대 MIME과 일치하는지 `subTest`로 확인한다. 패치 전에는 두 신규 케이스가 압축 타입 대신 본문 타입을 반환해 실패, 패치 후 dict 매핑으로 압축 MIME을 반환해 통과한다.
- **overfit·regression 관점:** FAIL_TO_PASS가 1개로 얇긴 하나, `subTest` 2케이스가 키 문자열과 MIME 값을 모두 고정하므로 키를 확장자로 잘못 매핑하는 흔한 오답을 빨갛게 잡는다 — special-case 통과 여지가 거의 없어 overfit 위험은 낮다(flag 미부여). regression-trap도 약함: 21개 P2P는 전부 `FileResponse` 헤더 동작이며 신규 키 추가는 `.get` 기본값 경로(기존 비압축 케이스)를 전혀 건드리지 않아 인접 동작이 깨질 표면이 없다.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 "FileResponse" + "Mime Type guessing" + 재현 코드(`.Z`/`.br`)를 신호로 `django/http/response.py`의 `FileResponse` 클래스로 직행. `set_headers` 안에서 `mimetypes.guess_type` 호출과 그 반환 `encoding`을 받는 dict(`{"bzip2":..., "gzip":..., "xz":...}.get(encoding, content_type)`)가 유일한 결정 지점임을 확인. `grep "application/gzip"`이면 단번에 그 dict.
2. **픽스와 일반화 정당성:** dict에 `"br": "application/x-brotli"`, `"compress": "application/x-compress"` 추가. 이게 올바른 일반화인 이유는 — 결함이 "두 케이스만 깜빡한 누락"이 아니라 `mimetypes`가 인식하는 압축 인코딩 집합과 django 매핑 테이블의 불일치이고, `.br`/`.Z`는 `mimetypes.encodings_map`이 정의하는 인코딩이므로 그 명칭(`"br"`/`"compress"`)을 키로 채우는 것이 기존 `"gzip"`/`"bzip2"` 엔트리와 정확히 동형(同型)인 패턴 확장이기 때문. 확장자가 아니라 인코딩 명칭을 키로 쓴 것이 일반화의 핵심.
3. **regression 안전:** 21개 P2P(전부 `FileResponse` 헤더: content-disposition/content-length/content-type/repr 등)는 신규 키와 무관한 경로다. `.get(encoding, content_type)` 기본값 분기를 그대로 두므로 비압축·기존 압축(`.gz`/`.bz2`/`.xz`) 케이스 동작이 보존된다. content type 결정 로직 자체를 리팩터하지 않는 한 깨질 인접 동작 없음.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) 키를 확장자 `".br"`/`".Z"`로 쓰거나 `"brotli"`/`"Z"` 등으로 추측하면 `mimetypes`가 돌려주는 `encoding`과 안 맞아 테스트가 계속 실패. 실제로 `mimetypes.guess_type("x.br")`/`("x.Z")`를 호출해 반환 인코딩 문자열을 확인하는 것이 유일한 안전장치다. (b) 증상이 `text/html`이라고 해서 content type 추론(`guess_type` 결과) 자체를 손대면 안 되고, 압축 인코딩 분기 dict만 보강해야 한다. (c) MIME 값을 임의로 만들지 말고 IANA/django 관례(`application/x-brotli`, `application/x-compress`)를 따라야 `subTest` 비교를 통과한다.
