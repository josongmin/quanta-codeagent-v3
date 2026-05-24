# ADR-0135 — Permission profile + file_system_sandbox_policy 2-layer + 4-pillar Permission

- **Status**: Proposed (2026-05-24, W5 of [[0130-extracted-source-absorption-roadmap]])
- **Related**: [[codex-seatbelt-sandbox-profile]] (macOS Seatbelt + Linux Landlock baseline), [[codex-collaboration-mode-pattern]] (Plan mode dispatch-seam mutating 차단), [[may-21-codex-r5-implementation]] (permission stack + HITL 4-tier ADR 0045~0049)
- **References**:
  - Codex sessions JSONL `turn_context.permission_profile.file_system` (type: restricted/managed, entries with `path.type: special/path`, access: read/write)
  - Codex sessions JSONL `turn_context.file_system_sandbox_policy` (별도 layer, 같은 entry 형태)
  - Codex `comment-preload.js`: `Permission.{approval, network, sandbox, control.managed}` 4-pillar
  - Codex `comment-preload.js`: `execApprovalRequest.network.*` (allow once/session/always) + `automaticApprovalReview.actionSummary.networkAccess`
  - Codex `comment-preload.js`: `Scope.{user, project, managed, open}` 4-tier RBAC

## Problem

우리 현 permission system ([[may-21-codex-r5-implementation]] ADR-0045~0049 permission stack + HITL 4-tier):

- **Single layer**: permission check 한 단계. sandbox 정책과 permission 정책이 같은 layer
- **3 pillar 정도**: approval / sandbox / control. **network는 명시적 분리 안 됨**
- **Scope 단일**: user / system 정도. project / managed 구분 없음

Codex의 2-layer + 4-pillar (R3+R4 발견):

### 2-layer file system
1. **permission_profile.file_system**: 사용자 권한 — "사용자가 이 path 읽기/쓰기 허락했나"
2. **file_system_sandbox_policy**: sandbox 정책 — "이 path를 sandbox가 expose하나"
- 둘 다 same `path.type: special/path` + `access: read/write` schema
- **AND 조건**: 두 layer 모두 allow여야 access OK. 한쪽이 deny면 deny

### 4-pillar Permission
1. **approval**: human-in-loop (allow once / session / always)
2. **network**: 외부 network access (R4: `execApprovalRequest.network` 별도 channel + `automaticApprovalReview.actionSummary.networkAccess`)
3. **sandbox**: process sandbox (현재 우리 covered)
4. **control.managed**: org-policy enforce (admin override 막음)

### 4-tier Scope
1. **user**: 사용자 개인 권한
2. **project**: 현 repo/project 한정
3. **managed**: admin-enforced (사용자 override 불가)
4. **open**: 공개 (anyone)

## Decision

`PermissionStack` ([[may-21-codex-r5-implementation]] ADR-0045)을 2-layer × 4-pillar × 4-scope으로 확장. **Backward compat**: 현 permission API는 default scope=user + pillar=approval로 매핑.

### 1. 2-layer file system permission

```typescript
interface FileSystemEntry {
  path: { type: "special"; kind: "root" | "project" | "tmpdir" | "git" | "agents" | "quanta" }
       | { type: "path"; value: string };
  access: "read" | "write";
}

interface PermissionProfile {
  file_system: {
    type: "restricted" | "managed";
    entries: FileSystemEntry[];
  };
  // 4 pillars
  approval: ApprovalPolicy;
  network: NetworkPolicy;
  sandbox: SandboxPolicy;
  control: ControlPolicy;
}

interface FileSystemSandboxPolicy {
  // 같은 schema, 별도 인스턴스
  type: "restricted" | "managed";
  entries: FileSystemEntry[];
}

// Access check: BOTH must allow
function canAccess(path: string, op: "read" | "write", profile: PermissionProfile, sandbox: FileSystemSandboxPolicy): boolean {
  return checkEntries(path, op, profile.file_system.entries)
      && checkEntries(path, op, sandbox.entries);
}
```

- **AND 조건 강제**: 둘 다 allow여야 OK
- `path.type: special` 8 kind: `root` / `project` / `tmpdir` / `git` / `agents` / `quanta` / `slash_tmp` / `tmp` — special path는 OS-specific resolve (e.g. macOS `tmpdir` = `/var/folders/...`)
- `path.type: path`는 literal path

### 2. 4-pillar Permission (현 stack 확장)

```typescript
type Pillar = "approval" | "network" | "sandbox" | "control";

interface ApprovalPolicy {
  mode: "auto" | "once" | "session" | "always";  // HITL 4-tier (현 ADR-0047)
  prompt_user: boolean;  // false면 silent fail on missing approval
}

interface NetworkPolicy {  // NEW
  mode: "deny-all" | "allow-list" | "allow-all";
  allow_hosts?: string[];  // mode=allow-list일 때
  per_request_approval?: boolean;  // mode=allow-list 더라도 each request prompt
}

interface SandboxPolicy {  // 기존 strengthen
  os_sandbox: "seatbelt" | "landlock" | "windows-sandbox" | "none";  // [[codex-seatbelt-sandbox-profile]]
  read_only: boolean;  // workspace 외부 read-only
  workspace_write: boolean;
  network_isolated: boolean;
}

interface ControlPolicy {  // NEW (admin override prevention)
  managed_by?: "user" | "team" | "admin";  // admin 시 user override 불가
  audit_required: boolean;  // 모든 행위 audit log
}
```

### 3. 4-tier Scope

```typescript
type Scope = "user" | "project" | "managed" | "open";

// Scope precedence (높을수록 enforce 강함):
// managed > project > user > open
// managed scope의 policy는 user/project가 override 불가
```

Skill scope ([[0134-skill-scope-tiering]])과 유사하지만 더 단순 (4-tier vs 7-tier). Permission은 7-scope까지 갈 필요 없음 (admin이 enforce 채널 + project는 repo-level).

### 4. AutoApprovalReview

[[may-21-codex-r5-implementation]] auto-approval과 합쳐서:

- 자동 승인 후 **review summary** 생성 (Codex `automaticApprovalReview.actionSummary.networkAccess` 같은 패턴)
- 주기적 review prompt (default: 매 10 auto-approval마다 1번 사용자에게 "이 정책 OK?" 확인)

## Alternatives considered

1. **OR 조건**: rejected — security 약함. permission_profile이 user 권한, sandbox는 OS-level enforced — 두 layer 다 통과해야 안전.
2. **3-pillar 유지** (network 분리 안 함): rejected — network은 가장 큰 attack surface (외부 호출). 별도 channel 필수.
3. **6-tier scope** (skill scope 7과 align): rejected — permission은 더 단순, admin/team이 같은 enforce class (managed). open은 명시적 공개 (drift surface).
4. **special path를 string으로** (`"<tmpdir>"`): rejected — typo 위험. enum kind로 type-safe.

## Invariants preserved

1. **현 PermissionStack ([[may-21-codex-r5-implementation]] ADR-0045) backward compat**: API는 default scope=user + pillar=approval + sandbox 단일 layer로 매핑. 기존 caller 변경 없음.
2. **HITL 4-tier (ADR-0047)** 그대로 ApprovalPolicy.mode로 흡수.
3. **[[codex-seatbelt-sandbox-profile]]** 그대로 SandboxPolicy.os_sandbox enum (seatbelt/landlock/windows-sandbox).
4. **2-layer AND condition**: file system access는 양쪽 다 allow 필요 — security 강화.
5. **audit_required 시 모든 행위 log**: control.managed 일 때 자동 enforce.
6. **closed-port**: PermissionChecker는 OS sandbox port inject.
7. **smoke battery**: 현 permission smoke test (memory [[smoke-fixture-system]]) 모두 pass. 신규 case는 2-layer / 4-pillar / 4-scope.

## Tradeoffs

- **2-layer = 검사 비용 2배**: 모든 file access에 2 lookup. mitigation: in-memory cache + LRU eviction (hit rate ~95% 예상).
- **4-pillar = config 복잡도 ↑**: profile.toml에 4 section. mitigation: 합리적 default (mode=session approval, mode=allow-list with empty list = deny-all network).
- **managed scope = enterprise만 의미 있음**: 개인 사용자에겐 overkill. mitigation: scope=user가 default, managed는 opt-in (org-policy.json 필요).
- **special path resolve OS-specific**: macOS `tmpdir` vs Linux `/tmp` 다름. mitigation: 각 OS에 resolver, fallback `os.tmpdir()`.
- **AutoApprovalReview prompt frequency 0이면 무의미, 너무 잦으면 fatigue**: default 10 trigger, 사용자 설정 가능.
- **메모리 [[codex-collaboration-mode-pattern]] Plan mode와의 인터랙션**: Plan mode은 dispatch-seam mutating 차단 — 이 ADR의 sandbox/approval과 별도. Plan mode entry 시 모든 mutating tool block, permission check 이전에 차단.
- **Permission × hook ordering (P1 cleanup 2026-05-25)**: The permission stack runs BEFORE the `pre_tool_use` hook (steps 9 vs 11 in the canonical 13-step dispatch pipeline — see `src/agent/dispatch.ts` `dispatchTool` header). Implications: (a) a permission deny short-circuits BEFORE the hook fires — the hook can never "save" a denied call; (b) a hook returning `{updatedInput}` on an admitted call rewrites the tool args AFTER permission saw the ORIGINAL input, with NO re-permission check on the rewrite (operator-trust model — see ADR-0133 Tradeoffs); (c) HARD_DENY skips BOTH layers; (d) plan-mode mutating block runs even earlier (step 1, dispatch-seam guard). Locked by `tests/unit/permission-hook-ordering.test.ts` (14 cases).

## Out of scope (deferred)

- **per-request network approval UI**: V2 (UI surface 별도 ADR).
- **Audit log query/export tooling**: V2 (audit infrastructure 별도).
- **Cross-machine sandbox** (예: SSH execution, container offload) — V3.
- **Scope=open의 정확한 의미**: V2에서 결정 (현재는 ignore — 사용자가 명시적 open 필요).
- **Skill scope ([[0134-skill-scope-tiering]])와 permission scope 통합**: 두 개념은 다름 (skill = "어떤 skill 보임" / permission = "이 행위 OK"). 통합 안 함.

## Validation (post-implementation)

- [ ] 현 [[may-21-codex-r5-implementation]] permission stack test 모두 pass (backward compat)
- [ ] 2-layer AND condition test: profile allow + sandbox deny → deny / profile deny + sandbox allow → deny
- [ ] 4-pillar 각각 sample case (approval once/session/always, network allow-list, sandbox seatbelt/landlock, control managed audit)
- [ ] 4-scope precedence: managed > project > user > open
- [ ] special path 8 kind 모두 OS-specific resolve test
- [ ] AutoApprovalReview prompt 10 trigger 후 발화 test
- [ ] [[codex-collaboration-mode-pattern]] Plan mode 진입 시 permission 검사 이전 차단 확인
- [ ] smoke battery permission 카테고리 byte-identical 회귀 0
- [x] **Permission × hook ordering** (P1 cleanup 2026-05-25): `tests/unit/permission-hook-ordering.test.ts` 14 tests pin the permission-vs-hook interaction: permission deny precludes hook fire, hook rewrites are post-permission, HARD_DENY skips both layers, plan-mode blocks even earlier.
