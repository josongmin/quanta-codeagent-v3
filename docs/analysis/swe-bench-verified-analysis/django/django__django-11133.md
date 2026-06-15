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
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-11133

## 문제 요약
`HttpResponse`에 `memoryview` 객체를 content로 넣으면 본문이 깨진다. Postgres에서 `BinaryField`를 읽으면 `memoryview`가 반환되는데, `HttpResponse(memoryview(b"My Content")).content`가 실제 바이트(`b'My Content'`) 대신 `b'<memory at 0x...>'`처럼 객체의 repr 문자열을 바이트로 변환한 값을 돌려준다. 사용자는 `str`/`bytes` content와 동일하게 원본 바이트가 그대로 들어가길 기대한다. problem_statement에 세 가지 입력(str/bytes/memoryview)을 나란히 보여주는 재현 코드가 첨부돼 있어 기대-실제 차이가 명확하다.

## 유형 (정형화)

- **L0 (Pinpointed)** — problem_statement가 `HttpResponse(...).content` 경로를 직접 지목하고, hints_text가 한 발 더 나가 `HttpResponseBase.make_bytes`를 명시적으로 거명하며 "casting them to bytes"라는 픽스 방향과 `force_bytes`의 memoryview 지원 선례(커밋 d680a3f4)까지 인용한다. grep 한 방, 사실상 함수 이름을 손에 쥐여준다.
- **S1 (Direct-Map / template)** — 정형 결함 클래스(타입 분기 누락 = missing-type-handling)에 템플릿 매칭된다. 픽스는 추론 합성이 아니라 기계적으로 "기존 bytes 분기에 memoryview를 합류"시키는 것. 이슈가 픽스를 사실상 명세하므로 S2(올바른 식·조건을 추론)나 S3/S4(후보 다수·테스트 반복) 영역이 아니다. `bytes(memoryview)`가 원본 버퍼를 복사한다는 건 표준 파이썬 동작이라 추론 비용이 없다.
- **K-Gen (General)** — 일반 파이썬 지식(`isinstance` 튜플, `memoryview`→`bytes` 캐스팅)만으로 충분하다. django 내부 ORM/query-compiler 같은 도메인 지식이 병목이 아니다. `make_bytes`가 응답 본문 직렬화 진입점이라는 위치는 hints가 떠먹여준다.

**primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 S1 기계적 타입-가드 확장이다. T-LocTrivial과 경계에 있으나, 이슈가 "픽스를 거의 적어주는" 수준은 아니고 (정확히 어느 isinstance를 어떻게 넓힐지는 코드를 봐야 함) 가드 확장이라는 결함클래스 매칭이 본질이라 T-DirectMap이 더 정확하다.

## 난이도 티어
**T1 (존나쉬움)** — 공식 라벨 `<15 min fix`와 일치. 이 티어로 미는 구조적 피처:
- 단일 파일(`django/http/response.py`) · 단일 함수(`make_bytes`) · 1줄 변경(헌크 1개). ICLR 2024 구조컷에서 1파일·<5줄은 ~48% solve 구간(최상위 easiness).
- L0 직접 localize + has-repro(첫 시도 해결률 ~87% 신호). 픽스 후보가 사실상 하나라 overfit 위험 없음.
- K-Gen, 도메인 추론 없음.

유일하게 T1에서 약간 끌어올릴 수 있는 요인은 64개의 넓은 PASS_TO_PASS(`regression-trap` 플래그) — bytes/str/iterator/lazy/streaming/JSON/Cookie/QueryDict 경로를 안 깨야 한다. 하지만 골드 패치가 isinstance 튜플에 항목 하나만 추가하는 가산적(additive) 변경이라 인접 경로에 부수효과가 구조적으로 없다. 따라서 P2P trap이 실질 난이도를 높이지 못해 T1을 유지한다. 공식 라벨과 불일치 없음.

## 골드패치 분석
- **건드린 파일/함수**: `django/http/response.py` → `HttpResponseBase.make_bytes`
- **근본 원인**: `make_bytes`는 `isinstance(value, bytes)` 분기, 그다음 `isinstance(value, str)` 분기를 검사하고, 둘 다 아니면 마지막 fallback에서 `str(value).encode(...)`로 처리한다. `memoryview`는 `bytes`도 `str`도 아니므로 fallback으로 떨어져 `str(memoryview)` = repr 문자열(`'<memory at 0x...>'`)을 인코딩해버린다. 주석에 명시됐듯 `force_bytes`를 의도적으로 안 쓰는 함수라(charset 재인코딩 회피), force_bytes의 memoryview 지원이 자동 상속되지 않는 게 결함의 직접 원인.
- **수정 요지**: 바이트 분기를 `isinstance(value, bytes)` → `isinstance(value, (bytes, memoryview))`로 확장해, `memoryview`도 곧장 `return bytes(value)`로 가도록 한다. `bytes(memoryview)`는 버퍼를 그대로 복사하므로 원본 바이트가 보존된다. 분기 순서(bytes-tuple 검사가 str 검사보다 앞)는 유지된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_memoryview_content (httpwrappers.tests.HttpResponseTests)` — `r = HttpResponse(memoryview(b'memoryview'))` 생성 후 `r.content == b'memoryview'`를 단언.
- **픽스 증명**: 패치 전에는 `make_bytes`가 memoryview를 fallback으로 보내 `r.content == b'<memory at ...>'`가 되어 단언 실패. 패치 후에는 새 튜플 분기가 memoryview를 잡아 `bytes(value)`로 변환하므로 `b'memoryview'`가 되어 통과. 테스트가 정확히 결함 경로(타입 분기 누락)를 친다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 픽스가 isinstance 튜플 확장이라 special-case 통과(예: `value == memoryview(b'memoryview')`일 때만 동작) 같은 overfit이 구조적으로 불가능하다. 어떤 memoryview든 동일 경로를 타므로 일반화가 자동 보장. `overfit-risk` 플래그 미부여.
- **regression 관점**: 64개 PASS_TO_PASS가 bytes/str/iterator/lazy content, streaming, JSON, Cookie, QueryDict 등 인접 동작을 폭넓게 고정한다(`regression-trap`). 가산적 변경이라 기존 bytes/str 분기는 그대로이므로 회귀 위험은 낮지만, 안전망 자체는 넓다.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 재현 코드에서 `HttpResponse(...).content`가 깨진다는 신호 → content 흐름은 `HttpResponse.__init__`/`content.setter` → `make_bytes`로 수렴. hints_text가 `HttpResponseBase.make_bytes`를 직접 거명하므로 추가 탐색 없이 `django/http/response.py`의 `make_bytes`로 직행. 거기서 `bytes`/`str` 분기와 fallback `str(value).encode()`를 보면 memoryview가 fallback으로 새는 게 즉시 보인다.
2. **픽스와 일반화 근거**: `isinstance(value, bytes)`를 `isinstance(value, (bytes, memoryview))`로 넓혀 memoryview를 `bytes(value)` 경로로 보낸다. 이게 올바른 일반화인 이유: (a) `bytes(memoryview)`는 임의의 memoryview 버퍼를 원본 그대로 복사하므로 특정 입력에 묶이지 않는다, (b) bytes와 memoryview는 둘 다 "이미 바이트 버퍼"라는 점에서 동일 처리가 의미상 맞다(charset 재인코딩 불필요), (c) force_bytes가 같은 결정(d680a3f4)을 이미 내린 선례가 있다.
3. **regression 안전**: `str` 분기, lazy/iterator/streaming, JSON·Cookie·QueryDict 경로(64 P2P)를 안 깨야 한다. 가드를 bytes 분기 *앞쪽*에 추가하지 말고 기존 bytes 분기에 memoryview만 합류시키면, str과 fallback 로직은 손대지 않으므로 이들 경로가 그대로 보존된다. 분기 순서 유지가 핵심.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) repr 문자열(`b'<memory at ...>'`)이 멀쩡한 바이트처럼 보여 "예외가 안 났으니 정상"으로 오판; 실제 본문 값을 비교해야 결함이 드러난다. (b) hints가 force_bytes를 언급한다고 `utils/encoding.force_bytes`를 고치러 가는 유혹 — 골드는 `make_bytes`가 force_bytes를 *의도적으로 안 쓴다*(charset 재인코딩 회피, 주석에 명시)는 걸 존중해 make_bytes 자체를 고친다. force_bytes를 건드리면 다른 호출처에 부수효과가 생기거나 charset 동작이 바뀔 수 있다. (c) streaming/`make_bytes` 외 경로까지 과하게 손대면 P2P 회귀. 정답은 한 줄, 분기 튜플 확장으로 최소 수렴하는 것.
