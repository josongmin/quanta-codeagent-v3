---
instance_id: pytest-dev__pytest-5262
repo: pytest-dev/pytest
base_commit: 58e6a09db49f34886ff13f3b7520dd0bcd7063cd
version: "4.5"
difficulty: "<15 min fix"
created_at: 2019-05-14T21:54:55Z
fail_to_pass: 1
pass_to_pass: 108
gold_files: [src/_pytest/capture.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-API
flags: [has-repro]
---

## 문제 요약
`_pytest.capture.EncodedFile`은 캡처된 stdout/stderr를 감싸는 텍스트-시맨틱 래퍼인데, `mode` 속성이 `__getattr__` 위임을 통해 내부 바이너리 버퍼의 모드(`rb+`)를 그대로 노출한다. youtube-dl처럼 `out.mode`에 `b`가 있는지 보고 `str`/`bytes` 분기를 결정하는 소비자는 이 잘못된 신호를 보고 `bytes`를 쓰는데, `EncodedFile.write()`는 Python3에서 `bytes`를 받으면 `TypeError`를 던진다. 즉 모드 광고와 실제 write 계약이 모순된다. 이슈는 재현 스크립트와 정확한 픽스 스니펫까지 포함한다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈 본문이 파일·클래스·줄까지 직접 지목(`_pytest.capture.EncodedFile`, capture.py#L450-L451 링크). grep 한 방. 근거: 심볼명이 곧 수정 대상.
- **S1 +S2 (Repair)**: 이슈가 픽스를 사실상 명세한다(`return self.buffer.mode.replace('b', '')`). 기계적 매핑이라 S1 dominant. 보조 S2인 이유는 "왜 `b`만 제거가 올바른가"(텍스트 래퍼는 str을 받으므로 binary 플래그를 떼는 것이 정확한 의미)라는 작은 계약 추론이 깔려 있기 때문.
- **K-API (Knowledge)**: 파일 객체의 `mode` 문자열 관례(`r`/`w`/`b`/`+`)와 텍스트 vs 바이너리 스트림 계약을 정확히 맞춰야 함. 도메인(pytest 내부)이 아니라 파일 API 계약 지식.
- **primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 가드/속성 추가 수준의 기계적 매핑(S1)이라 T-DirectMap. 이슈가 코드까지 줘서 T-LocTrivial에 근접하지만, `mode` property가 `__getattr__` 위임을 가로채야 한다는 미세한 계약 판단이 있어 순수 T1/T-LocTrivial보다 한 칸 위.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`src/_pytest/capture.py`) 1헌크, +4줄(`mode` property 추가)뿐. localize 직접성 최상(L0, 이슈가 줄번호 링크 제공). `has-repro`(네이티브 `TypeError` 스택트레이스 + 최소 재현 스크립트) — 가장 강한 easiness 신호. P2P가 107개로 많지만 모두 `mode` 속성과 무관한 기존 capture 동작이라 진짜 regression-trap이 아니다(인접 동작 변경 없음). 공식 라벨 `<15 min fix`와 일치하며, 단지 "왜 `b`만 제거"라는 경미한 계약 추론 때문에 최하 T1이 아니라 T2로 둔다.

## 골드패치 분석
- **파일·심볼**: `src/_pytest/capture.py`, `EncodedFile` 클래스에 `mode` property 신규 추가.
- **근본원인**: `EncodedFile.__getattr__`이 정의되지 않은 속성을 모두 `self.buffer`로 위임한다. `buffer`는 `os.fdopen(newfd, mode, 0)`로 열린 바이너리 스트림(`rb+`)이라, `EncodedFile.mode`를 읽으면 `b`가 포함된 바이너리 모드가 노출된다. 그러나 `EncodedFile.write()`는 텍스트(`str`)만 받고 `bytes`는 `TypeError`로 거부한다 → "광고된 모드(binary)"와 "실제 write 계약(text)"의 불일치.
- **수정요지**: 명시적 `mode` property를 추가해 `self.buffer.mode.replace("b", "")`를 반환. `__getattr__` 위임을 가로채 텍스트 래퍼답게 `b`를 떼서 노출. 다른 모드 플래그(`r`/`+`)는 보존하므로 소비자의 읽기/쓰기 방향 판단은 유지된다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `TestFDCapture::test_capfd_sys_stdout_mode` — `capfd` fixture 하에서 `assert "b" not in sys.stdout.mode`. 픽스 전에는 `sys.stdout`(=EncodedFile)이 `rb+`를 위임 노출해 `b`가 있어 실패, 픽스 후 property가 `r+`를 반환해 통과.
- **픽스 증명**: 테스트는 정확히 근본원인의 외부 증상(노출된 모드에 `b` 존재)을 직접 단언한다. property 추가가 곧 단언 충족.
- **overfit/regression 관점**: 픽스는 `replace("b","")`라는 일반적 변환이라 special-case가 아니다(특정 입력에만 맞춘 게 아님). 다만 테스트가 `capfd` 한 경로만 검증해 얇다(`overfit-risk` 후보). 그래도 EncodedFile은 sys/fd 캡처 양쪽에서 동일 클래스라 일반화가 자연스럽다. P2P 107개(`test_typeerror_encodedfile_write` 등)는 모두 통과 유지 — `mode` property 추가가 기존 write/encoding 동작을 건드리지 않으므로 regression 없음.

## 모범답안 (오라클 기반)
1. **localize 경로**: 스택트레이스 마지막 프레임 `_pytest/capture.py:437: TypeError`와 메시지 `write() argument must be str, not bytes` → `EncodedFile.write`로 직행. 이슈가 "`mode`가 `rb+`를 잘못 광고" 라고 진단하고 capture.py#L450-L451을 링크하므로 `EncodedFile`의 모드 노출 경로(`__getattr__` 위임)가 곧 수정 지점. L0.
2. **픽스와 일반화 근거**: `EncodedFile`은 텍스트 시맨틱 래퍼이므로 자신의 `mode`는 텍스트 모드여야 한다. binary 플래그 `b`만 제거하고 나머지(`r`/`w`/`+`)는 보존하는 `self.buffer.mode.replace("b","")`가 정확한 계약 표현. 모드 문자열을 통째로 하드코딩(`"r"` 등)하지 않고 버퍼에서 파생하므로 다양한 기저 모드에 대해 일반화된다(올바른 일반화).
3. **regression 안전**: 기존 `write`/`writelines`/`name`/`encoding` 동작은 손대지 않는다. P2P의 `test_typeerror_encodedfile_write`(bytes 거부 동작), `test_pickling_and_unpickling_encoded_file`, capsys/capfd binary 변형들이 그대로 통과해야 하며, property는 읽기 전용 신규 속성이라 이들을 깨지 않는다.
4. **함정 회피**: (a) 힌트의 첫 시도처럼 `CaptureIO`/`StdCapture` 레벨에 테스트를 붙이면 `'CaptureIO' object has no attribute 'mode'`로 엉뚱하게 실패한다 — 수정 대상은 `EncodedFile`이지 `CaptureIO`가 아니다(오라클 테스트가 `capfd` 경로를 택한 이유). (b) `mode` 전체를 상수로 박지 말 것(버퍼가 `rb`냐 `rb+`냐에 따라 `+`가 달라짐 — `replace`로 파생해야 함). (c) `__getattr__`를 건드려 일반 위임을 깨면 다른 속성 fall-through가 망가지므로, 위임을 막지 말고 `mode` property로만 가로채는 것이 핵심.
