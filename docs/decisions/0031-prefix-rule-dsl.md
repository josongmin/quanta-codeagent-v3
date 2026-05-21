# ADR-0031 — Prefix-rule allowlist DSL + 3-layer precedence

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0020 (HITL 4-tier gate), ADR-0026 (admissibility-gate
  SSOT), ADR-0027 (anti-signals / policy-injection hardening),
  ADR-0029 (Reviewer 3-tier). Codex 메모
  [[codex-rule-dsl-pattern]] (default.rules — 1060 `allow` prefix rules,
  100% allow, default-deny) + [[codex-feature-catalog-2026-05-21]] §I
  (prefix_rule allowlist DSL, Tier 0).

## Context

quanta-v3는 현재 permission/admissibility 경로에서 "안전한 명령"의 enum이
코드에 박혀 있다 (`src/permission/policy.ts` 등). 새 명령을 안전 목록에
추가하려면 코드 수정 + PR + 배포가 필요했고, 운영자(operator)/리포지토리별
정책을 분리해 적용할 방법이 없었다.

Codex (`~/.codex/rules/default.rules`, 353KB / 1060 prefix rules)는
이를 텍스트 DSL로 외부화한다:

- 한 줄 = 한 rule (`allow <prefix>`).
- 100% allow rule (deny 없음).
- rule 없으면 default-deny.
- prefix-match는 단어 경계(공백 구분).

Codex는 단일 파일이지만, 우리는 vendor 기본값 / 사용자 / 리포 정책을
독립적으로 관리해야 한다 — 그래서 3-layer가 필요하다.

## Decision

새 slice `src/rules/`를 도입한다. 기존 `src/agent/repo-rules.ts`는
markdown rule ingestion(SSOT 본문 주입)을 담당하는 다른 모듈이라
이름이 비슷해도 책임이 다르다 — **수정하지 않는다**.

### 1. 슬라이스 구조 (신규 파일 only)

| 파일                              | 책임                                                |
| --------------------------------- | --------------------------------------------------- |
| `src/rules/types.ts`              | `Rule`, `RuleAction`, `RuleLayer`, `MatchOutcome`, `RuleParseError`, `RuleConflictError` |
| `src/rules/parser.ts`             | `parseRules(text, layer, sourceFile): Rule[]` — pure, fail-loud |
| `src/rules/matcher.ts`            | `matchCommand(cmd, rules): MatchOutcome` — longest-prefix-match |
| `src/rules/store.ts`              | `RulesStore` — 3-layer (`project > user > system`) |
| `src/rules/index.ts`              | barrel                                              |

barrel + `tsconfig.json`에 `@/rules` path alias 추가. 다른 slice의
import 제약은 변하지 않는다 (이번 PR에서 어떤 다른 slice도 `@/rules`를
import하지 않는다).

### 2. DSL 문법 (SSOT)

```
# 주석은 `#`으로 시작. 빈 줄 무시.
# 형식: <action> <command-prefix>
allow git status
allow git diff
allow npm test
deny  rm -rf
ask   git push
```

- action ∈ `{allow, deny, ask}` — closed enum. 다른 토큰 → `RuleParseError`.
- prefix는 비어 있을 수 없다. leading/trailing whitespace strip, 내부
  whitespace 보존.
- 같은 prefix + 같은 action → silent dedupe (observationally identical).
- 같은 prefix + **다른 action** → `RuleParseError` ("conflicting actions").
- 주석은 라인 단위만 — 라인 내부의 `#`는 prefix의 일부.

### 3. Matcher 알고리즘 (deterministic)

1. command 정규화: leading whitespace만 strip (trailing 보존 — 우회 방지).
2. rules를 prefix length **내림차순** + 원본 index **오름차순**으로 stable sort.
3. 각 rule에 대해 다음 조건이면 매칭:
   - `command === rule.prefix`, 또는
   - `command.startsWith(rule.prefix)` && `command[len] === ' '` (ASCII 0x20).
4. 첫 매치 반환. 없으면 `{ kind: "no_match" }`.

→ `git` rule이 `github`를 매칭하지 않는다 (space 경계).
→ `git push --force` rule이 `git push` rule보다 우선 (longest-prefix).
→ 탭(`\t`)은 경계로 인정하지 않는다 — 런타임 간 동작이 갈리는 휴리스틱.

### 4. 3-layer 우선순위 (Codex 초월)

```
project > user > system   (FIXED — RulesStore가 이 순서로 iterate)
```

- 각 layer 내부는 longest-prefix-match.
- 다른 layer 간에는 **layer가 specificity를 이긴다** — project의 짧은
  prefix가 system의 긴 prefix를 override (project override의 의도).
- `loadLayer(layer, text, sourceFile)`는 layer를 통째로 교체 (merge 아님).
  parse 실패 시 store 상태는 **변경되지 않는다** (atomic).

### 5. Codex 대비 확장

| 항목                        | Codex                        | quanta-v3 (이번 ADR)                   |
| --------------------------- | ---------------------------- | -------------------------------------- |
| Action enum                 | `allow` only                 | `allow` / `deny` / `ask`               |
| Default behaviour           | default-deny                 | caller-decided (admissibility-gate)    |
| File / Layer                | single `default.rules`       | 3-layer (system / user / project)      |
| Match algorithm             | prefix + space boundary      | 동일 + layer precedence                |

## Trade-offs

- **Parser 복잡도 ↑**: 그러나 한 함수(`parseRules`) + 명시적 named error
  + 1-indexed lineNumber로 진단성 확보. regex 없음, 폴백 없음.
- **운영자 학습 비용 ↑**: 3-layer 의미론을 문서화해야 한다 (본 ADR + 카탈로그 §I).
- **상쇄**: 새 명령 허용에 코드 변경 불요. 운영자가 user/project rule 파일을
  편집하는 것으로 정책을 진화시킬 수 있다.
- **deterministic**: pure 모듈, 클럭 없음, 랜덤 없음, fs 없음 → snapshot
  / replay 친화적.

## Integration seam (구현 X — 후속 PR)

본 슬라이스는 `src/rules/` 모듈 + 단위 테스트만 포함한다.
admissibility-gate와의 결선은 **이번 PR에서 수정하지 않는다**
(ADR-0026의 SSOT 원칙대로 통합은 별도 PR).

다음 PR에서 결선할 위치 + 계약:

- **파일**: `src/agent/admissibility-gate.ts`
- **진입 지점**: HARD_DENY 게이트 직전 (rule이 그 자리에서 결과를
  단축할 수 있도록). 정확한 위치는 ADR-0026의 게이트 순서를 따른다.
- **주입 계약**:
  - `AgentConfig.permission`에 `rulesStore?: RulesStore` +
    `noMatchPolicy?: "deny" | "fallthrough"` 옵션 추가.
  - `rulesStore` 미주입 시 게이트는 byte-identical 경로를 유지한다
    (1300+ 기존 테스트 회귀 없음).
- **결정 매핑** (`RulesStore.match(shellCommand)` 결과 → admissibility):

  | MatchOutcome             | admissibility 동작                                |
  | ------------------------ | ------------------------------------------------- |
  | `matched / allow`        | HITL/mode 게이트 우회 → 즉시 admit                 |
  | `matched / deny`         | terminal deny — reviewer 호출 없이 차단            |
  | `matched / ask`          | ADR-0029 `ReviewerPort`에 escalate (3-tier 결정)  |
  | `no_match` (strict)      | `noMatchPolicy="deny"` → default-deny             |
  | `no_match` (fallthrough) | `noMatchPolicy="fallthrough"` → 기존 게이트 경로  |

  **결정 (본 ADR)**: 기본값은 `"fallthrough"` — 회귀 위험 최소화.
  Codex 동등의 strict default-deny는 운영자가 opt-in한다.

- **trajectory event**: `matched / ask` 경로는
  `ReviewContext.priorDenials`에 누적되는 결정을 그대로 사용 (ADR-0029).
  `matched / deny`는 `DenialMemory` 발행 (sticky 우선순위 적용).

## Codex reference 매핑

| Codex 구성요소                                    | quanta 대응                              |
| ------------------------------------------------- | ---------------------------------------- |
| `~/.codex/rules/default.rules`                    | system layer 입력 텍스트                 |
| `allow <prefix>` 라인                             | `RuleAction = "allow"` + `prefix`        |
| (없음) deny rule                                  | `RuleAction = "deny"` (확장)             |
| (없음) HITL escalate                              | `RuleAction = "ask"` (확장)              |
| (없음) 3-layer                                    | `RulesStore` precedence (확장)           |
| 100% allow + default-deny                         | `noMatchPolicy="deny"` opt-in            |
| prefix-match + space boundary                     | `matchCommand` (동일 알고리즘)           |

## Migration

기존 호출자는 영향 없음. `RulesStore`를 주입하지 않는 한 admissibility
경로는 byte-identical로 유지된다 — `noMatchPolicy` 기본값
(`"fallthrough"`)이 이를 보장한다.

운영자가 점진적으로 도입할 수 있도록 권장 흐름:

1. system layer에 Codex `default.rules`를 그대로 import해 baseline 확보.
2. user layer에 운영자별 `ask` rule을 얹어 reviewer escalation 정책 강화.
3. project layer에 리포지토리 특화 `deny` rule을 얹어 위험 명령 차단.
4. 운영자 확신이 서면 `noMatchPolicy="deny"`로 전환해 Codex 동등의
   strict allowlist 모드로 진입.
