# RFC 03: execpolicy-amendment 흡수 — 모델이 승인규칙을 제안하고 영속화하는 패턴

- **상태**: Draft / **USER SIGN-OFF 필요** (구현 착수 전 명시적 승인 없이는 진행 금지)
- **날짜**: 2026-07-13
- **출처**: Codex 5059 `ExecPolicyAmendment` 흡수 후보
- **위험등급**: **최고위험(HIGHEST-RISK)**. 이 후보만 다른 흡수 후보와 달리 **에이전트가 자기 승인표면을 확장**하게 만든다.

---

## 0. North-star 제약 (이 문서를 지배한다)

autonomy가 올라가면 위험도 같이 올라간다. 이건 기능개수 북극성이 아니라 **agent state 가시성** 북극성과도 직교하며, 오히려 우리 HARD_DENY / no-heuristics 안전문화와 **정면충돌**한다.

세 개의 하드 제약이 이 문서 본문 어떤 주장보다 우선한다.

1. **default-OFF, byte-identical.** knob 미설정 시 승인표면이 지금과 완전히 동일해야 한다.
2. **USER sign-off 선행.** 다른 흡수 후보(01/02)는 measure-first로 바로 랜딩 가능하지만, 이 후보는 **구현 착수 전에 사용자 명시 승인**이 필요하다. 이 문서는 그 승인을 받기 위한 자료다.
3. **HARD_DENY는 amend 불가.** HARD_DENY 대상(rm -rf 등)이 amend를 통해 allow로 바뀌는 순간 = **즉시 reject**. 이건 협상 대상이 아니라 load-bearing 안전 불변식이다.

---

## 1. 흡수 대상 — Codex 근거

Codex의 `ExecPolicyAmendment`: 모델이 승인규칙(command prefix)을 **제안**하고, 사용자가 **승인**하면, 그 규칙이 policy에 **영속화**되어 이후 매칭되는 명령이 승인을 우회한다.

증거(`/Users/songmin/quanta-codeagent-v3/.extracted_source/codex/_codex-bin-symbols.txt`):

- `type ExecPolicyAmendment` (L4795-4796, L10905): "Proposed execpolicy change to allow commands starting with this prefix ... added as an execpolicy `prefix_rule(..., decision=allow)`, letting the agent bypass approval."
- 승인 스코프 두 종류(L10717-10718, L42099):
  - `approved_for_session` — ephemeral(세션 한정)
  - `approved_execpolicy_amendment` — permanent(policy에 영속)
- `proposed_execpolicy_amendment` — 모델의 제안 상태(L5835, L10717).
- `prefix_rule(pattern=...)` (L9359), `rules prefix_rule at index ...` (L7539-7545) — 규칙이 인덱스된 prefix_rule 목록으로 persist됨.
- 영속 확인 문자열: "network rule saved in execpolicy" (L8465), "failed to persist network policy amendment to execpolicy" (L7874).
- `RequirementsExecPolicyToml` 계열 — org/config가 규칙소스를 강제(org-cap).
- `justification` 필드가 승인요청에 동반됨(`ExecApprovalRequestEvent` ... `proposed_execpolicy_amendment` L42575).

즉 Codex의 흐름: **모델 제안(prefix) → 사용자 승인 → decision=allow prefix_rule로 policy 영속 → 런타임이 이후 매칭 명령을 gate 없이 통과.** 세션 스코프와 영속 스코프가 분리되어 있고, `justification`이 필수로 붙는다.

---

## 2. 현황 (anti-dup — 실제 repo 검증)

우리 승인/게이팅 스택을 실제로 읽고 대조한다. **결론부터: 이건 TRUE-GAP이 아니라 PARTIAL이다.** 필요한 seam이 이미 거의 다 존재하며, 정확히 하나의 조각(모델-제안 prefix가 baseline을 벗어날 때 사용자 승인 후 영속되는 경로)만 빠져 있다.

### 2.1 승인은 어떻게 도는가 (canonical gate order)

`src/agent/admissibility-gate.ts:77-186`의 `runAdmissibilityGate`가 SSOT. 순서:

1. mode-posture block (`admissibility-gate.ts:103`)
2. **HARD_DENY 조기차단 — `earlyHardDeny` (`admissibility-gate.ts:111`)** ← 보안경계, allow-capable bypass(rules/reviewer/permissionPatternStore)가 켜지면 rules/HITL/pattern보다 **앞으로 당겨진다**.
3. hand-off-required floor (`admissibility-gate.ts:120`) — "어떤 mode도 authorize 못 함"
4. permission_request hook → tool-profile → **pattern auto-pass** (`admissibility-gate.ts:154`) → rules DSL → HITL → permission stack → mode policy → pre_tool_use hook.

핵심: HARD_DENY가 rules/pattern/trust-scope/HITL **전부보다 먼저** 판정된다. `src/permission/policy-rules.ts:91`의 `HARD_DENY_RULES`가 데이터 SSOT이고 `HARD_DENY`(L299)가 flat 패턴 배열. `policy.ts:270,398,533`에서 "HARD_DENY ALWAYS wins — read-only fast-path보다도 먼저"가 반복 강제됨.

### 2.2 1-shot인가 session-persist인가 — 둘 다 있다

- **1-shot**: legacy `onConfirm` boolean(`confirm-decision.ts:113-116`) — `true`/`false` 한 번.
- **session-persist (ephemeral)**: `ConfirmDecision.scope` 유니온(`confirm-decision.ts:48`) = `"once" | "session" | "session_prefix"`.
  - `session` = 이 exact actionKey만.
  - `session_prefix` = program 토큰 prefix(예: 모든 `git …`). 컨트롤러가 `sessionPrefixGrants: Set<string>`에 in-memory로 유지(`context-binding.ts:93`). 오퍼레이터의 명시적 `session_prefix` verb에만 mint(`context-binding.ts:117`).
  - prefix 안전장치는 이미 강함: `session-grant-prefix.ts`의 `derivePrefixGrantKey`(L77)가 `SHELL_METACHARS`(L43, `;&|<>(){}$\`` 등) 있으면 key 도출 거부 → 체이닝 스머글링 차단. 키는 `tool|<firstToken>` 토큰경계 매칭(L82), raw substring 아님.

**이게 정확히 Codex `approved_for_session`이다.** 우리는 이미 갖고 있다.

### 2.3 rule-persistence는 있는가 — **있다** (Codex `approved_execpolicy_amendment` 아날로그)

`src/permission/trust-scope-store.ts` — L3→L4 승격된 **영속** trust-scope grant store.

- `~/.quanta/*.json`에 파일로 persist, debounced atomic write(store header L55-59), concurrent write는 `mergeWithDisk`로 last-write-MERGE.
- grant 레코드 shape(L17-31): `tool` / `scope` / `actionKey`(예 `bash|git status`) / `commandPattern`(예 `"npm,install"` leading-token, Cursor `suggested_allowlist_entry`형) / `grantedAt` / `ttlMs`(옵션 TTL).
- cascade: exact → command-pattern → project → global, most-specific wins(L48).
- `grant(projectKey, grant)`가 durable 여부를 리턴(`durable:false`면 disk 실패 신호, audit L8 M6). `revoke`도 존재.
- 게이트 소비: `src/agent/admissibility-gate/gates.ts:377` `trustScopeGrants` → `config.trustScope.registry.hasGrant(...)`(L394). **DEFAULT OFF**(L381 `if (!config.trustScope) return false`).
- 여기에도 이미 prefix 스머글 가드가 박혀 있다: `gates.ts:391` — persist된 `commandPattern`이 first-token 매칭이라 체이닝 위험 → session-prefix와 **동일한** `isSimpleCommand` metachar 가드를 적용, 복잡명령은 재프롬프트(fail-closed). 그리고 명시 주석(gates.ts:390): **"HARD_DENY already precedes this gate."**

**즉 "규칙을 disk에 영속하고 이후 매칭 명령을 gate 없이 통과"시키는 인프라(Codex의 영속 amendment 절반)는 이미 존재한다.** trust-scope grant가 정확히 그 역할.

### 2.4 모델-제안(propose) 경로도 있다 — 단, no-widen으로 잠겨 있다

`src/permission/gate-pattern-wire.ts:168` `recordProposedPattern` + `src/permission/remember-patterns.ts`의 `PatternGrantStore`:

- 모델이 패턴을 **propose**하면 store에 record → 이후 구조적으로 동등한 action이 `autoPassByPatterns`로 auto-pass.
- **핵심 불변식(load-bearing)**: propose는 **user/policy baseline에 이미 covered된 패턴만** record 가능(`gate-pattern-wire.ts:184` `if (!store.isBaseline(p)) return { reason: "would_widen" }`). record는 `allowed`에만 쓰고 `baseline`엔 안 씀(`remember-patterns.ts:135` `recordProposed`) → **chain-widen 불가**(방금 record한 걸로 다음 propose 못 함). 배치는 all-or-nothing atomic(L183, laundering 방지).
- dangerous 자기플래그는 `allowDangerous` 없으면 항상 reject(`gate-pattern-wire.ts:178`).

**여기가 결정적 차이다.** 우리 propose는 "사용자가 이미 승인한 것 안에서만 refine" 한다. Codex의 amendment는 **정반대** — 모델이 **새로운(baseline 밖)** prefix를 제안하고, 사용자가 승인하면 그게 **새 규칙**이 된다.

### 2.5 sandbox escalation도 유사 패턴 (fail-closed 레퍼런스)

`src/host/runtime/sandbox-escalation-wire.ts` — sandbox block → 사용자게이트 escalation. NEVER-auto: timestamp 순서 3-step 재승인 강제(L34-36), `onConfirm` 미배선이면 fail-closed(L73-74), `justification`은 AUDIT sink에만 흐르고 telemetry엔 안 감(L35-36). 이건 "새 권한을 열되 항상 사람 게이트를 통과"의 우리 레퍼런스 구현이다.

### 2.6 분류: **PARTIAL**

| Codex 조각 | 우리 상태 | 위치 |
|---|---|---|
| `approved_for_session` (ephemeral) | **있음** | `confirm-decision.ts:48` `scope:"session"/"session_prefix"`, `context-binding.ts:93` |
| prefix_rule 규칙 형태 | **있음** | `session-grant-prefix.ts` `tool\|<firstToken>`, trust-scope `commandPattern` |
| `approved_execpolicy_amendment` (permanent, disk) | **있음** | `trust-scope-store.ts` `~/.quanta/*.json` 영속 grant |
| 모델 propose → record | **있음(잠김)** | `recordProposedPattern`, baseline 안에서만 |
| **모델이 baseline 밖 prefix 제안 → 사용자 승인 → 영속 규칙 신설** | **없음** ← 유일 gap | — |
| `justification` 필드 | **있음** | escalation card `justification` (`stream-callbacks.ts:264,288,297`), `skill-scope-escalation.ts:51` |
| org-cap (`RequirementsExecPolicyToml`) | **있음(아날로그)** | rules DSL `noMatchPolicy`, HARD_DENY corpus가 상한 |

**빠진 건 딱 하나**: 모델이 **새 prefix 규칙을 제안 → 사용자가 justification과 함께 승인 → trust-scope store에 영속** 하는 배선. 나머지 부품(제안 seam, 승인 seam, 영속 store, prefix 안전장치, HARD_DENY 선행, justification 채널)은 전부 존재한다.

---

## 3. 제안 — 기존 seam 재사용

만든다면 새 store/새 게이트/새 grep을 도입하지 않고, **§2에서 확인한 기존 seam만 연결**한다. 부품이 다 있으므로 흡수는 "부품 조립 + 안전 하드핀"이지 신규 엔진이 아니다.

### 3.1 제안 흐름 (amendment flow)

```
모델: propose_exec_rule({ prefix, justification })   ← 신규 leaf 도구, default-OFF
  │  prefix = tool|<firstToken> 형(derivePrefixGrantKey 재사용, 단일 simple 명령만)
  │  justification REQUIRED (비면 즉시 reject, no fallback)
  ▼
게이트: earlyHardDeny 먼저 판정 (admissibility-gate.ts:111)
  │  prefix가 HARD_DENY에 매칭되면 → 즉시 reject (§4, amend 불가)
  ▼
승인 UI: onConfirm 에 새 verb 노출 — "이 prefix를 영구 허용"
  │  ConfirmDecision.scope 유니온 확장: "permanent" 추가
  │  (기존 "once"/"session"/"session_prefix" 옆에)
  │  프롬프트에 prefix + justification 를 verbatim 표시 (INFORMED consent)
  ▼
사용자 승인 → trustScope.registry.grant(projectKey, {
  │    tool, actionKey|commandPattern: <prefix>, grantedAt, ttlMs?
  │  })  ← 기존 trust-scope-store 영속 경로 그대로
  ▼
런타임 allowlist refresh: 다음 매칭 action이 trustScopeGrants(gates.ts:377)로 통과
  │  (여기도 이미 isSimpleCommand metachar 가드 + HARD_DENY 선행)
```

세션 vs 영속 스코프 분리:
- `scope:"session_prefix"` → 기존 in-memory `sessionPrefixGrants`(Codex `approved_for_session`).
- `scope:"permanent"`(신규) → trust-scope-store 영속(Codex `approved_execpolicy_amendment`).
- 둘 다 **오퍼레이터 명시 verb에만** mint. 평범한 approve는 절대 permanent를 만들지 않는다(`session_prefix`가 plain approve에 안 붙는 것과 동일 원칙, `context-binding.ts:92`).

### 3.2 justification 필수

- `propose_exec_rule`의 `justification`이 빈 문자열/누락이면 도구가 typed reject(no fallback, `ConfirmDecisionError` 스타일). sandbox-escalation의 정직성(justification은 AUDIT sink에만, telemetry 금지 — `sandbox-escalation-wire.ts:35`)을 그대로 따른다.
- 승인 UI가 justification을 verbatim으로 보여줘 사용자가 "왜 이 규칙인지" 판단하게 한다. justification 없는 amendment는 no-go.

### 3.3 org-cap (Codex `RequirementsExecPolicyToml` 아날로그)

새 규칙소스를 만들지 않고 **기존 게이트 rule-source를 상한으로 재사용**한다:
- HARD_DENY corpus(`policy-rules.ts`)가 절대 상한 — amend가 뚫을 수 없음(§4).
- rules DSL `noMatchPolicy:"deny"`가 설정되면 amend 후보도 그 상한 아래.
- 조직/프로젝트가 `.quanta/project-grants.json` overlay(trust-scope-store L130+)로 permanent amendment 자체를 비활성/화이트리스트 제한 가능. 이게 우리판 org-cap이다 — 새 TOML 포맷 도입 불필요.

---

## 4. 안전 하드핀 (CRITICAL — load-bearing)

**HARD_DENY 대상은 amendable 하지 않아야 한다.** 이게 전체 흡수의 생사 조건이다.

### 4.1 구조적 보장 (이미 성립)

canonical gate order(§2.1)에서 `earlyHardDeny`가 trust-scope/pattern/rules/HITL **전부보다 앞**이다(`admissibility-gate.ts:111` vs trust-scope는 later ask-branch `gates.ts:408`). 따라서:
- amendment로 `bash|rm` prefix 규칙을 영속시켜도, `rm -rf /` action은 `trustScopeGrants`에 도달하기 **전에** `earlyHardDeny`에서 걸린다.
- `gates.ts:390` 주석이 이미 이 계약을 명문화: "HARD_DENY already precedes this gate."

### 4.2 추가 하드핀 (amend 시점에서도 이중차단)

구조적 후행차단만 믿지 않는다. **amend를 승인하는 시점에** HARD_DENY 매칭 prefix면 애초에 규칙을 만들지 못하게 한다:
- `propose_exec_rule` 도구가 prefix에 대해 `hardDenyReason` 체크(`policy.ts`의 HARD_DENY 프로브 재사용)를 선행 → 매칭되면 propose 자체가 typed reject. 이유는 "HARD_DENY hit on tool=bash" 수준으로만(정규식 source/명령 전문 절대 노출 금지, `policy.ts:111,121` 보안 불변식 준수).
- 즉 **amend 시점(propose+approve)과 실행 시점(gate) 양쪽**에서 HARD_DENY가 이긴다.

### 4.3 red-on-injection 테스트 (필수 게이트)

이 테스트가 green이 아니면 흡수 착수 자체가 금지다.

- **HD-1 (실행 시점)**: `bash|rm` prefix를 permanent amend로 영속시킨 store를 게이트에 주입 → `rm -rf /tmp/x` action → **여전히 hard-deny로 차단**됨을 단언. 주입 지점: trust-scope registry에 `rm` grant를 심고 gate를 태워 deny를 관찰.
- **HD-2 (amend 시점)**: `propose_exec_rule({ prefix:"bash|rm", justification:"x" })` → typed reject(HARD_DENY) 관찰. 사용자 승인 UI까지 도달하지 않음.
- **HD-3 (mutation red)**: earlyHardDeny를 amend 경로에서 우회하도록 소스를 mutate(예: trust-scope 체크를 HARD_DENY 앞으로 옮김) → **HD-1이 RED**로 뒤집힘을 증명. mutation이 잡히지 않으면 테스트가 vacuous.
- **HD-4 (justification 강제)**: `justification:""` → typed reject, 어떤 규칙도 record 안 됨.
- **HD-5 (chain smuggle)**: `bash|git` permanent amend 후 `git status && rm -rf /` → `isSimpleCommand` metachar 가드(gates.ts:391)로 re-prompt, 통과 0.

**HD-3가 이 흡수의 crown**이다. HARD_DENY를 amend가 뚫을 수 있게 만드는 어떤 변경도 즉시 reject — 이건 측정문제가 아니라 안전 불변식이다.

---

## 5. 측정 / 게이트

### 5.1 지표

- **friction 감소(순기능)**: permanent amend 도입 후 반복 명령의 재승인 프롬프트 횟수 감소(같은 prefix에 대한 중복 onConfirm 콜 수). trajectory에서 `(prefix, approve)` 반복 카운트.
- **wrongful-permanent-allow incident rate(역기능)**: 사용자가 승인했지만 나중에 위험했던 permanent grant 수. revoke 발생률 + TTL 만료 후 재승인 거부율로 근사. 이 지표가 friction 감소를 초과하면 **롤백**.
- 두 지표는 safety(HD-1~5)와 **혼합 금지**. HARD_DENY 불변식은 A/B 대상이 아니라 항상-green 하드게이트.

### 5.2 게이트

- **default-OFF, byte-identical.** knob(`QUANTA_EXEC_AMENDMENT` 류) 미설정 시 도구 미등록 + `scope:"permanent"` 미노출 → 승인표면 지금과 동일.
- **USER sign-off 선행(명시).** 01/02 후보와 달리 이 후보는 measure-first로 바로 못 켠다. §4 red-on-injection 5종이 green + 사용자 명시 승인 후에만 구현 착수. 승인 없이는 이 문서로 종료.
- TTL 기본값을 강제(무한 permanent 금지 옵션) — Claude Desktop 2h 레퍼런스처럼 permanent amend에 만료를 붙일지 사용자 결정사항.

---

## 6. effort / risk (정직하게)

- **effort**: 부품이 다 있어 **배선 자체는 작다**(신규 leaf 도구 1 + `ConfirmDecision.scope`에 `"permanent"` 1개 + trust-scope grant 호출 1지점 + UI verb). ~1일 규모. 하지만 **안전 하드핀 + red-on-injection 5종 + 적대어딧 ≥3R이 본체**이며 그게 배선의 몇 배다.
- **risk**: **높음.** 이 후보는 우리 안전문화(HARD_DENY 절대성, no-heuristics, 자기승인 금지)와 정면으로 맞선다. 구조적으로 HARD_DENY가 선행하고 우리 propose가 no-widen으로 잠겨 있어 "잘 막혀 있다"는 사실 자체가, 이 후보가 **의도적으로 열어둔 문을 다시 뚫는 것**임을 방증한다. `recordProposedPattern`의 baseline-only 잠금(§2.4)은 버그가 아니라 **설계된 방어**다 — amendment는 그 방어를 완화하자는 제안이다.
- **정직한 결론**: 이건 no-go일 수 있다. 순기능(friction 감소)이 그리 크지 않다(session_prefix로 세션 내 반복은 이미 해결됨). permanent가 사는 유일한 케이스 = **세션 경계를 넘는 반복**(매 세션 같은 `git`/`npm` 승인). 그 이득이 자기승인표면 확장이라는 영구위험을 정당화하는지는 사용자만 판단할 수 있다.

---

## 7. 기각/보류한 변형

- **모델 propose를 baseline 밖까지 auto-record**(사용자 게이트 없이): 즉시 reject. `recordProposedPattern`의 no-widen을 무력화 = 자기승인. Codex도 사용자 approve를 반드시 요구한다.
- **HARD_DENY를 amend 우선순위 아래로**: 즉시 reject(§4).
- **justification 옵션화**: reject. Codex도 필수, 우리 정직성 문화도 필수.
- **새 policy 파일포맷(TOML 등) 도입**: 불필요. trust-scope-store가 이미 영속 + cascade + overlay를 제공.

---

## 8. 3줄 요약 + 권고

1. Codex `ExecPolicyAmendment`(모델 제안 prefix → 사용자 승인 → 영속 규칙)의 부품은 우리 repo에 거의 다 있다 — session-prefix grant(=`approved_for_session`), trust-scope 영속 store(=`approved_execpolicy_amendment`), propose seam, justification 채널, HARD_DENY 선행. 분류는 **PARTIAL**, 빠진 건 "모델이 baseline 밖 prefix 제안 → 사용자 승인 → 영속" 배선 하나뿐.
2. 그러나 우리 `recordProposedPattern`의 baseline-only 잠금은 **설계된 방어**이고, amendment는 그 문을 다시 여는 제안이라 우리 HARD_DENY/no-self-grant 안전문화와 정면충돌한다. friction 이득은 session_prefix로 세션 내엔 이미 해결됐고, permanent의 순증 가치는 세션 경계 반복 하나로 얇다.
3. HARD_DENY가 구조적으로 선행하고(gate order상 amend가 그걸 못 뚫음), red-on-injection HD-1~5(특히 mutation HD-3)로 불변식을 핀할 수 있으므로 **기술적으로는 안전하게 흡수 가능**하다.

**권고: absorb-with-guards, 단 USER sign-off 조건부 — 실질적으로 no-go 기울음.**
근거: (a) 안전 하드핀(HARD_DENY 비-amendable + red-on-injection 5종 + 적대어딧 3R)이 green이면 기술적 흡수는 안전하지만, (b) 순기능이 얇아(session_prefix로 대부분 커버) 자기승인표면 확장이라는 영구위험 대비 ROI가 낮다. 사용자가 "세션 경계 넘는 반복 승인"을 실제 pain으로 지목하지 않는 한 **착수 보류(no-go)**를 권한다. 착수한다면 §4 하드핀이 문자 그대로 load-bearing이며, 그 중 하나라도 무너지면 흡수 전체를 reject한다.
