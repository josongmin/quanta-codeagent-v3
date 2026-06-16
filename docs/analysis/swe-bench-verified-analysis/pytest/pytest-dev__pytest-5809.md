---
instance_id: pytest-dev__pytest-5809
repo: pytest-dev/pytest
base_commit: 8aba863a634f40560e25055d179220f0eefabe9a
version: "4.6"
difficulty: "<15 min fix"
created_at: 2019-09-01T04:40:09Z
fail_to_pass: 1
pass_to_pass: 3
gold_files: [src/_pytest/pastebin.py]
primary_type: T-LocTrivial
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro]
---

## 문제 요약
`pytest --pastebin`은 실행 출력을 `bpaste.net`에 업로드할 때 `lexer=python3`(py2면 `python`)로 보내는데, 일부 `contents`에서 bpaste가 "HTTP Error 400: Bad Request"를 던진다. 업로드되는 건 파이썬 코드가 아니라 pytest 콘솔 출력(임의 텍스트)이므로 `lexer`를 `text`로 바꾸면 호출이 정상 통과한다. 이슈 본문이 정확한 파일·줄(L68-L73)·재현코드·픽스("`python3`→`text`")를 모두 명시한다.

## 유형 (정형화)
- **L (Localization): L0** — 이슈가 `src/_pytest/pastebin.py`의 정확한 라인(L68-L73)을 GitHub permalink로 직접 지목. `create_new_paste`의 `params` 딕셔너리 한 곳. grep("lexer") 한 방.
- **S (Repair Strategy): S1 (Direct-Map)** — 이슈가 픽스를 사실상 문장으로 적어준다("`lexer`를 `python3`에서 `text`로 바꾸면 통과"). 상수 값 교체. 추론 합성 불필요.
- **K (Knowledge): K-Gen** — bpaste의 lexer 의미만 알면 끝. pytest 내부 도메인 지식·API 계약 불필요. "콘솔 출력은 파이썬 코드가 아니다"는 일반 추론.
- **primary type: T-LocTrivial** — L0 + S1 + has-repro. 찾는 즉시 픽스가 자명. APR 관점에서 template/direct-map의 교과서적 사례(상수 리터럴 치환).

## 난이도 티어
**T1 (존나쉬움).** 구조적 피처: 단일 파일·단일 헌크·실질 1줄(딕셔너리 리터럴 한 줄로 축약), localize 직접성 최상(L0, permalink+줄번호), `has-repro`(네이티브 `urlopen` 재현 스니펫 + data.txt 첨부), P2P trap 거의 없음(인접 테스트 3개는 캡처/포맷 경로라 lexer 값과 무관). 공식 라벨도 `<15 min fix`로 일치. T1의 전형 프로파일(L0+S1, 1파일 ≲10줄, has-repro, K-Gen)에 그대로 부합.

## 골드패치 분석
- **건드린 파일·함수:** `src/_pytest/pastebin.py` 내 `create_new_paste(contents)`.
- **근본원인:** `params["lexer"]`를 `"python3" if sys.version_info[0] >= 3 else "python"`로 설정. bpaste의 python3 lexer는 업로드 내용이 유효 파이썬으로 파싱되길 기대하는데, pytest 출력(ANSI/임의 텍스트)은 그 lexer 검증을 통과하지 못해 서버가 400을 반환.
- **수정요지:** 버전 분기를 제거하고 `params = {"code": contents, "lexer": "text", "expiry": "1week"}`로 고정. 콘텐츠 종류와 무관하게 텍스트 lexer를 쓰므로 파싱 검증 자체가 사라져 400이 근절. `sys.version_info` 분기 제거로 죽은 py2 코드도 정리.

## 검증 (test_patch)
- **FAIL_TO_PASS:** `testing/test_pastebin.py::TestPaste::test_create_new_paste` 1개. 테스트는 `mocked_urlopen`로 업로드 페이로드를 가로채 `data` 안에 `"lexer=%s" % lexer`가 들어있는지 단언하는데, 기대 `lexer`를 `"python3" if ... else "python"`에서 `"text"`로 갱신. 즉 픽스 후 전송되는 lexer가 `text`임을 바이트 레벨에서 증명.
- **픽스 증명:** `assert "lexer=text" in data.decode()` 형태로 실제 전송 파라미터를 관찰 — 단순 상태 단언이 아니라 wire payload 검증이라 픽스와 직결.
- **overfit/regression 관점:** FAIL_TO_PASS가 1개로 얇지만 결함클래스가 상수치환이라 special-case 여지가 없다(lexer는 `text` 한 값으로 수렴). PASS_TO_PASS 3개(`test_failed`/`test_all`/`test_non_ascii_paste_text`)는 캡처·다중 paste·비ASCII 경로로, lexer 값에 의존하지 않아 회귀 위험 낮음. overfit-risk/regression-trap 플래그 불필요.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 `pastebin.py#L68-L73`와 "lexer=python3"를 직접 명시 → `rg "lexer" src/_pytest/pastebin.py`로 `create_new_paste`의 `params` 딕셔너리에 즉시 도달. 탐색 비용 0.
2. **픽스와 일반화 근거:** `lexer`를 `"text"`로 고정. 올바른 일반화인 이유 — 업로드 대상은 pytest 콘솔 출력(임의 텍스트)이지 파이썬 소스가 아니므로, 어떤 `contents`에서도 파싱 검증을 강제하지 않는 `text`가 의미상 정확. 버전 분기 제거는 py2 드롭과 정합. 특정 입력(data.txt)만 우회하는 게 아니라 입력공간 전체를 커버.
3. **regression 안전:** PASS_TO_PASS 3개는 캡처 활성화·요약 출력·비ASCII 처리만 검증하고 lexer 문자열을 단언하지 않으므로 안 깨짐. `code`/`expiry` 키와 `urlencode(...).encode("ascii")` 인코딩 경로를 보존해야 비ASCII 테스트가 유지된다(딕셔너리 재작성 시 `code`/`expiry` 누락 금지).
4. **함정 회피:** (a) 분기 한쪽만 고쳐 py3 경로의 `"python3"`은 두고 py2 `"python"`만 바꾸는 식의 부분수정 — 분기 전체를 상수로 접어야 함. (b) `urlencode`의 `.encode("ascii")`를 건드려 비ASCII 입력(PASS_TO_PASS)을 깨는 과잉수정. (c) lexer를 `text` 대신 `python`으로 바꾸는 오해 — 여전히 파싱 검증 대상이라 400이 재발할 수 있음; 이슈가 명시한 `text`가 정답.
