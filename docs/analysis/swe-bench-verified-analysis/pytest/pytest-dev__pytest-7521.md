---
instance_id: pytest-dev__pytest-7521
repo: pytest-dev/pytest
base_commit: 41d211c24a6781843b174379d6d6538f5c17adb9
version: "6.0"
difficulty: "<15 min fix"
created_at: 2020-07-20T15:55:11Z
fail_to_pass: 2
pass_to_pass: 125
gold_files: [src/_pytest/capture.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-API
flags: [has-repro, regression-trap]
---

## 문제 요약

pytest 6.0.0rc1에서 `capfd.readouterr()`가 캡처된 출력의 `\r`(캐리지 리턴)을 `\n`으로 변환해 버린다. 즉 `print('...', end='\r')` 후 캡처하면 결과가 `'...\n'`이 되어 `endswith('\r')`가 깨진다(pytest 5에서는 정상). 이슈 작성자가 minimal reproducer와 bisect 결과(#6899 "EncodedFile 단순화" 커밋)까지 제공한, 명백한 회귀 버그다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 심볼을 직접 지목하진 않지만 `capfd`/`readouterr`/캡처 경로라는 강한 키워드 + bisect 커밋(#6899, EncodedFile 변경)으로 `src/_pytest/capture.py`의 FD 캡처 텍스트 래퍼로 거의 즉시 수렴. grep 한두 번.
- **S2 (Constraint-Reasoning) + S1**: 고칠 지점(텍스트 래퍼 생성부)은 자명하지만, 올바른 픽스는 "universal-newline 변환을 꺼야 한다"는 io.TextIOWrapper의 newline 인자 의미를 추론해 `newline=""`을 합성하는 것. 기계적 가드는 아니고 텍스트 I/O 불변식 추론. 일단 알면 한 줄이라 S1 성격도 섞임.
- **K-API**: `io.TextIOWrapper(newline="")`의 계약(빈 문자열=변환 비활성·줄바꿈 원형 보존, `None`=universal-newline 변환)을 정확히 알아야 함. CPython 표준 텍스트 I/O API 계약 의존.
- **primary = T-ConstraintReason**: 위치는 쉽게 잡히나, 핵심 난점은 "왜 `\r`이 `\n`이 되는가 → TextIOWrapper의 기본 newline 동작"이라는 인과를 짚고 올바른 인자값을 추론하는 데 있음. localize가 아니라 constraint 추론이 본질.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 단일 파일·단일 헌크·**+1줄**(`newline=""` 추가), reproducer 제공(has-repro, 가장 강한 easiness 신호), bisect로 원인 커밋 명시. 공식 라벨도 "<15 min fix"로 일치. T1이 아닌 이유는 이슈가 픽스를 글자 그대로 적어주지 않고 io 텍스트 래퍼의 newline 의미를 알아야(K-API) 하기 때문 — None 가드 같은 순수 기계적 픽스가 아니다. P2P가 131개로 넓어 regression-trap이 약하게 존재하지만(인접 캡처 동작 다수), 픽스가 newline 처리만 좁게 건드려 실제 깨질 위험은 낮아 티어를 올리지 않음.

## 골드패치 분석

- **파일·함수**: `src/_pytest/capture.py` — `FDCaptureBinary.__init__` 내부, FD를 캡처하는 `EncodedFile`(= `io.TextIOWrapper` 서브클래스) 생성부.
- **근본원인**: #6899에서 `safe_text_dupfile()`을 제거하고 `EncodedFile`을 단순화하면서, `TemporaryFile`을 감싸는 `TextIOWrapper`에 `newline` 인자를 명시하지 않게 됐다. `TextIOWrapper`의 기본값 `newline=None`은 **universal-newline 모드**라, 읽기 시 `\r`·`\r\n`을 모두 `\n`으로 변환한다. 캡처 버퍼가 텍스트 디코딩을 거치며 캐리지 리턴이 소실된 것.
- **수정요지**: 생성자 인자에 `newline=""` 한 줄 추가. 빈 문자열은 universal-newline 변환을 비활성화하고 줄바꿈 문자를 입력 그대로 보존하므로, `\r`/`\r\n`/`\r` 단독이 변형 없이 통과한다.

## 검증 (test_patch)

`testing/test_capture.py::TestCaptureFixture::test_cafd_preserves_newlines`를 `nl in ("\n", "\r\n", "\r")`로 parametrize: `print("test", end=nl)` 후 `capfd.readouterr()` 결과가 `out.endswith(nl)`인지 단언.

- **FAIL_TO_PASS (2)**: `[\r\n]`, `[\r]` 케이스. 픽스 전엔 둘 다 `\n`으로 뭉개져 실패, `newline=""` 추가 후 원형 보존되어 통과. 픽스가 정확히 이 두 변환 경로를 끈다는 직접 증명.
- **PASS_TO_PASS (131)**: `[\n]` 케이스는 P2P에 포함 — `\n`은 변환 전후 동일하므로 픽스가 LF 동작을 안 깬다는 보장. 광범위한 캡처/로깅 회귀 스위트(SysCapture/FDCapture/Tee/logging)가 모두 유지되어야 함.
- **overfit·regression**: `\r`, `\r\n`, `\n` 세 줄바꿈 변종을 모두 커버해 special-case 우회가 불가능 → overfit 위험 낮음. P2P가 넓어 regression-trap은 있으나 변경이 newline 의미에만 국한돼 안전.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "capfd가 `\r`→`\n` 변환" + bisect 커밋(#6899 EncodedFile 단순화)을 신호로 `src/_pytest/capture.py`에서 FD 캡처의 텍스트 래퍼 생성부(`FDCaptureBinary.__init__`의 `EncodedFile(...)` 호출)를 찾는다. `\r` 손실 = 텍스트 디코딩 단계 의심.
2. **픽스**: `TextIOWrapper`의 기본 `newline=None`이 universal-newline 변환을 한다는 API 계약을 떠올려, `newline=""`을 추가해 변환을 끈다. `\r` 한 종류만이 아니라 모든 줄바꿈 변종을 원형 보존하는 일반적 해법이므로 올바른 일반화(특정 입력 하드코딩 아님).
3. **regression 안전**: `\n` 출력은 newline 비활성화 후에도 그대로라 LF 기반 기존 캡처/로깅 P2P(131개)를 깨지 않음. `write_through=True`, `errors="replace"` 등 다른 인자는 손대지 않아 디코딩 의미 불변.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `readouterr` 반환부에서 `.replace("\n","\r")` 같은 사후 문자열 치환으로 special-case 우회를 시도(overfit, `\r\n` 깨짐)하거나, (b) `newline=None` vs `""` vs `"\n"`을 혼동하기 쉽다. 정답은 **쓰기가 아니라 읽기 측 변환을 끄는 것**이며 `""`(보존)이지 `"\n"`(여전히 변환)이 아님을 io 문서로 확정해야 한다.
