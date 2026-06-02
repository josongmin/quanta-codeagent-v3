# RFC: Permission-Profile Inheritance (`extends` + cycle detection)

- Status: Draft (implementation-ready)
- Date: 2026-06-02
- Author: architect (jun-2-misc batch, slice 05)
- ADR (suggested): **ADR-0435** (`docs/decisions/` 최신 = `0434-permission-profile-list-select.md`; `0435+` 전부 free)
- Surfaces: CLI / Web-Tauri / CLI-embedded browser (surface-agnostic — pure resolver)
- Posture: closed-port / DI / **default-OFF** / pure / total / fail-closed / slice-fenced

---

## 1. Problem

`src/permission/named-profiles.ts`는 **3개의 고정 named profile**만 제공한다:
`default` (locked-down), `restricted` (stricter), `trusted` (most permissive).
이들은 frozen literal struct이며 **조합(composition) 수단이 전혀 없다**:

- `named-profiles.ts:36` `type NamedProfileName = "default" | "trusted" | "restricted"` — 닫힌 enum.
- `named-profiles.ts:87-91` `NAMED_PROFILES` — 3개의 frozen struct를 직접 박아 둔 레지스트리.
- `named-profiles.ts:103-112` `resolveProfileByName` — name → struct lookup, unknown name은 **THROW (fail-closed)**.
- `named-profiles.ts:96-97` `isNamedProfileName` — 3개만 narrow.

결과적으로 "**trusted인데 network만 막아라**" 같은 흔한 요구를 표현하려면
`profile-list-select.ts`의 user-defined `<name>.json`에 **5개 pillar 전부**를 손으로 다시 적어야 한다
(`profile-list-select.ts:321-343` `parseUserProfile`는 모든 pillar를 필수로 요구). 즉:

- **재사용 0.** 한 axis만 바꾸려 해도 base의 전체 struct를 복제해야 한다.
- **drift 위험.** base built-in이 바뀌어도 복제본은 따라가지 않는다.
- **표현력 부족.** "이 base를 깔고 이 axis만 좁힌다"는 가장 흔한 정책 표현이 불가능하다.

경쟁사(Codex)는 이미 **permissions profile inheritance**(`extends` 체인 + cycle detection +
Managed/External tagging)를 구현해 두었다. 본 RFC는 이를 흡수해, profile을
**3개 고정 preset이 아니라 합성 가능한 그래프**로 만든다.

---

## 2. Competitor evidence (Codex) — cite

소스: `.extracted_source/codex/_codex-rs-0.135-symbols.txt` (string table; grep-verified).

### 2.1 Inheritance + `extends` 어휘 (fail-closed)

`_codex-rs-0.135-symbols.txt` 내 인접 문자열 블록 (grep `-ao` 검증):

```
default_permissions refers to undefined profile `…`        # 5688 인근 블록
permissions profile `…` extends undefined profile `…`
permissions profile `…` cannot extend unsupported built-in profile `…`
```

→ Codex의 profile은 `extends`로 다른 profile을 가리키며, **undefined base는 에러**,
**built-in을 부적절하게 extend하는 것도 에러**. 즉 fail-closed 해소(resolution).

### 2.2 Cycle detection (THROW on cycle)

`_codex-rs-0.135-symbols.txt:5688`:
```
permissions profile inheritance cycle detected: …
```

→ inheritance 해소 중 **사이클을 감지하면 에러**. 조용히 끊지 않는다.

### 2.3 Merge serialize/deserialize round-trip (해소가 실제 merge를 수행)

`_codex-rs-0.135-symbols.txt:5689-5690`:
```
failed to serialize permissions profile while resolving inheritance: …
failed to deserialize merged permissions profile while resolving inheritance: …
```

→ inheritance 해소는 base→derived를 **실제로 merge한 새 struct**를 만든다 ("merged permissions profile").
serde round-trip 기반의 override-merge.

### 2.4 Managed vs External tagging (`TaggedPermissionProfile`)

`_codex-rs-0.135-symbols.txt` (grep `-ao`, count):
```
TaggedPermissionProfile::Managed     (6×)   …::Managedstruct
TaggedPermissionProfile::External    (6×)   …::Externalstruct
PermissionProfile::External
AdditionalPermissionProfile          (20×)
ManagedFileSystemPermissions         (17×)  ManagedFileSystemPermissionsUnrestricted / …entriesglob
```

→ profile은 **출처 태그**를 가진다: `Managed`(org/MDM이 내린 정책) vs `External`(user-defined).
`ManagedFileSystemPermissions{Unrestricted | entries+glob}` = managed 측 FS 권한의 별도 표현.
`AdditionalPermissionProfile` = base에 얹는 추가 profile(= derived).
`RequestPermissions{Event,Args,Response…}` (여러 변형)은 런타임 권한 요청 흐름 — 본 RFC 범위 아님.

**핵심 흡수 포인트**: (a) `extends` 체인, (b) cycle = THROW, (c) base→derived **merge**,
(d) **Managed가 External보다 강함(=ceiling)** — derived(External) profile이 Managed가 정한 한도를
**넓힐 수 없다**.

---

## 3. Quanta 현황 — cite (composition 없음 확인)

| 축 | 위치 | 현황 |
|---|---|---|
| Profile 타입 | `permission-profile.ts:126-135` | 5 pillar: `fileSystem` / `approval` / `network` / `sandbox` / `control`. `extends` 필드 **없음** |
| 기본 struct | `permission-profile.ts:197-211` | `DEFAULT_PERMISSION_PROFILE` (locked-down) frozen |
| Named 레지스트리 | `named-profiles.ts:87-91` | `NAMED_PROFILES` = 3 frozen struct **고정** |
| Resolve | `named-profiles.ts:103-112` | `resolveProfileByName` — unknown name **THROW** |
| Name guard | `named-profiles.ts:96-97` | `isNamedProfileName` — 3개만 |
| 4-scope precedence | `permission-profile.ts:150-184` | `PermissionScope = user\|project\|managed\|open`, `PERMISSION_SCOPE_PRECEDENCE_DESC` = `managed>project>user>open`, `strongerScope()` |
| Control managedBy | `permission-profile.ts:117-122` | `ControlManagedBy = user\|team\|admin`, `auditRequired` |
| User profile 로딩 | `profile-list-select.ts:321-343` | `parseUserProfile` — **5 pillar 전부 필수** (조합 불가) |
| 안전 ceiling | `profile-list-select.ts:476-495` | `exceedsCeiling` — user file은 `default` 보다 넓을 수 없음 (network/sandbox/prompt) |
| 2-layer 적용 | `two-layer-manager.ts:121-128` | `setPermissionProfileByName` → `resolveProfileByName` |
| Envelope 필드 | `src/session/envelope.ts:89,192-211` | `permission_profile` = enum(`default\|trusted\|restricted\|custom`) **OR** struct |
| Barrel | `src/permission/index.ts:60-67` | named-profiles export |

**확정**: quanta에는 4-scope precedence(`managed>project>user>open`)는 **있으나**
profile **`extends`/merge는 전혀 없다**. unknown name은 fail-closed로 THROW (`named-profiles.ts:104-110`).

---

## 4. Goals / Non-goals

### Goals
1. profile 정의에 `extends?: string`(또는 `string[]`)를 추가해 base→derived **합성**을 가능케 한다.
2. **순수·전역(total)·무 I/O** resolver `resolveProfileInheritance(name, registry)` — base→derived를
   **axis별로 정밀히 정의된 merge policy**로 합성.
3. **cycle detection** — 사이클이면 **THROW** (Codex fail-closed 미러).
4. **Managed vs External tag** — Managed가 정한 한도를 derived(External)가 **넓힐 수 없게** clamp/reject.
5. built-in 3개 + unknown-name fail-closed 동작 **100% 보존**.

### Non-goals
- 기존 3 named profile(`default`/`restricted`/`trusted`)의 의미/struct **변경 금지**.
- unknown-name silent fallback 도입 **금지** (계속 THROW).
- `profile-list-select.ts`의 disk-loading / `exceedsCeiling` 동작 변경 **금지** (직교; §8에서 연동만).
- 런타임 권한 요청 흐름(`RequestPermissions*`) 흡수 — 범위 밖.
- envelope wire schema의 **mandatory** 변경 — `extends`는 optional로만 추가 (backward-compat).
- gate 평가 경로(`policy.ts`/`access-check.ts`/`two-layer-manager.ts`) 핵심 로직 변경 — resolver는
  적용 **전(前)** 단계에서 struct를 만들어 넘긴다 (plane-clean).

---

## 5. Design

### 5.1 새 타입: `ProfileDefinition` (extends 필드를 가진 선언형)

`PermissionProfile`(완성된 struct)은 그대로 두고, **선언형(definition)** 레이어를 추가한다.
definition은 모든 pillar가 **partial**일 수 있고 `extends`를 가진다.

```ts
// 새 파일: src/permission/profile-inheritance.ts (leaf, pure)

/** 출처 태그 — Managed(org/MDM)가 External(user-defined)보다 강하다.
 *  Codex TaggedPermissionProfile::Managed / ::External 흡수. */
export type ProfileTag = "managed" | "external"

/** 한 axis도 빠질 수 있는 partial profile + extends 체인 + tag.
 *  완성된 PermissionProfile과 달리 pillar가 optional — base에서 상속받는다. */
export interface ProfileDefinition {
  /** base profile 이름(들). 좌→우 순서로 적용, 뒤가 앞을 override.
   *  built-in 이름 또는 다른 definition 이름. 없으면 base 없음. */
  readonly extends?: string | ReadonlyArray<string>
  /** 출처 태그. 미지정 ⇒ "external"(가장 낮은 신뢰). */
  readonly tag?: ProfileTag
  readonly fileSystem?: Partial<PermissionProfile["fileSystem"]> & {
    readonly entries?: ReadonlyArray<FileSystemEntry>
  }
  readonly approval?: Partial<ApprovalPolicy>
  readonly network?: Partial<NetworkPolicy>
  readonly sandbox?: Partial<SandboxPolicy>
  readonly control?: Partial<ControlPolicy>
}

/** name → definition 레지스트리 (built-in + user-defined를 합친 뷰). */
export type ProfileDefinitionRegistry = Readonly<Record<string, ProfileDefinition>>
```

> built-in 3개는 **완전한** `PermissionProfile`이므로 `ProfileDefinition`으로 어댑트할 때
> 모든 pillar가 채워진 definition(`extends` 없음)이 된다 — `asDefinition(p): ProfileDefinition`.

### 5.2 Resolver: `resolveProfileInheritance` (pure / total / fail-closed)

```ts
export interface ResolveInheritanceOpts {
  /** built-in fallback. registry에 없는 이름은 built-in에서 찾는다.
   *  built-in도 아니면 THROW(fail-closed). 기본 NAMED_PROFILES. */
  readonly builtins?: Readonly<Record<string, PermissionProfile>>
  /** Managed ceiling을 derived가 넘으면 throw(strict) vs clamp(조용히 좁힘).
   *  기본 "clamp" — fail-safe하게 좁히되, throw 모드는 strict org용. */
  readonly onManagedWiden?: "throw" | "clamp"
}

/** name을 extends 체인을 따라 해소해 완성된 PermissionProfile을 만든다.
 *  - 순수: I/O·전역상태 없음. registry는 호출자가 만든다.
 *  - 전역(total): 모든 입력에 대해 PermissionProfile 반환 OR THROW(중간 상태 없음).
 *  - fail-closed: unknown base/cycle/self-extend ⇒ THROW. */
export const resolveProfileInheritance = (
  name: string,
  registry: ProfileDefinitionRegistry,
  opts: ResolveInheritanceOpts = {},
): PermissionProfile => { /* §5.4 알고리즘 */ }
```

### 5.3 Merge semantics — **axis별 정밀 정의 (이 RFC의 핵심)**

merge는 `base`(이미 완성된 PermissionProfile)에 `derived`(partial definition)를 얹는다.
체인이 `[A, B] extends`로 `C`를 정의하면 적용 순서는 **left-to-right resolve → 자기 자신**:
`merge(merge(resolve(A), resolve(B)), C-own-fields)`.

각 axis의 결합 규칙은 **두 가지 원칙의 혼합**이다:

- **most-restrictive-wins (MRW)**: 보안에 영향을 주는 축. base가 좁혀 둔 것을 derived가 **넓힐 수 없다**.
- **override-wins (OW)**: 좁히기만 한다면 derived가 명시한 값으로 대체.

> 핵심 결정: **"좁히는 방향"은 OW로 자유롭게, "넓히는 방향"은 MRW로 금지.**
> 즉 *derived가 명시한 값과 base 값 중 더 좁은(more restrictive) 쪽을 채택*한다.
> 이렇게 하면 "trusted인데 network만 막기"(좁히기)는 되고, "restricted인데 network 열기"(넓히기)는 안 된다.
> derived가 axis를 **미지정**하면 base 값 그대로(상속).

#### (a) `network` — **MRW** (가장 보안 민감)

rank: `deny-all(0) < allow-list(1) < allow-all(2)` (이미 `profile-list-select.ts:449-453` `NETWORK_RANK`와 동일 — **재사용**).

- `mode` = `min(base.mode, derived.mode)` by rank. derived가 더 좁으면 채택, 넓히려 하면 base 유지.
- `allowHosts` (mode=`allow-list`일 때만 의미): **intersection** 채택할 수도 있으나,
  derived가 host를 *추가*하면 넓히기다 → **intersection(base ∩ derived)**.
  단 base가 host를 명시하지 않고 derived만 명시하면 = derived가 좁히는 것(allow-all→allow-list로 좁힐 때) → derived 채택.
  규칙: 결과 mode가 `allow-list`이고 양쪽 다 `allowHosts`가 있으면 `∩`; 한쪽만 있으면 그쪽; 없으면 빈 배열(가장 좁음).
- `perRequestApproval`: **OR** (둘 중 하나라도 true면 true — 더 엄격).

#### (b) `approval` — **MRW** (엄격도 ladder)

엄격도 ladder: `auto(0) < once(1) < session(2) < always(3)` (더 자주 묻는 쪽이 strict).

- `mode` = `max(base.mode, derived.mode)` by ladder rank. derived가 더 자주 묻게(좁게) 하면 채택, 덜 묻게(넓게) 하려 하면 base 유지.
- `promptUser`: **OR** (둘 중 하나라도 true ⇒ true; "묻지 않음"은 넓히기이므로 base가 묻으면 강제로 묻는다).

#### (c) `fileSystem` — **type: MRW, entries: intersection**

- `type` = `managed`가 `restricted`보다 강함. base가 `managed`면 derived는 `restricted`로 **약화 불가** → `managed` 유지.
  (rank `restricted(0) < managed(1)`, `max` 채택.)
- `entries` = **intersection** (base가 허용한 path만 derived가 더 좁힐 수 있다; derived가 path를 *추가*하면 넓히기 → 무시).
  intersection 정의: derived의 각 entry가 base의 어떤 entry에 **포함(containsPath)되고 access도 cover**되면 그 derived entry를 채택.
  derived가 entries를 **미지정**하면 base.entries 그대로 상속.
  derived가 빈 배열을 명시하면 = 전부 막기(가장 좁음) → 빈 배열.
  - access 좁히기: base에 `write` 있는 path를 derived가 `read`로 좁히면 `read` 채택(더 좁음).
  - `containsPath` 재사용: `access-check.ts:71-86` (단 resolver 필요 → §5.5 주석 참조; intersection은 special-path를 resolve 없이 *구조적 동등*으로 비교하는 보수적 버전 사용 = special kind+access 동일 OR literal path containment. resolver 없이 순수 유지).

#### (d) `sandbox` — **per-flag MRW**

- `osSandbox`: `none`이 sandbox 없음(가장 약함). 강도 rank `none(0) < seatbelt/landlock/windows-sandbox(1)`.
  base가 sandbox를 켰으면 derived가 `none`으로 끌 수 없음 → 강한 쪽 유지. 둘 다 enum이고 서로 다른 OS면 base 우선(플랫폼 정합성).
- `readOnly`: **OR** (true가 더 좁음).
- `workspaceWrite`: **AND** (false가 더 좁음 — base가 write 막았으면 derived가 못 연다).
- `networkIsolated`: **OR** (true가 더 좁음).

#### (e) `control` — **MRW**

- `managedBy`: 강도 `user(0) < team(1) < admin(2)`. **max** 채택 (admin이 잠근 것을 user로 못 내림).
- `auditRequired`: **OR** (true가 더 엄격; 한쪽이 audit 강제면 강제).

> 요약 표:

| axis | field | 규칙 |
|---|---|---|
| network | mode | MRW = min(rank) |
| network | allowHosts | intersection |
| network | perRequestApproval | OR |
| approval | mode | MRW = max(ladder) |
| approval | promptUser | OR |
| fileSystem | type | MRW = max(restricted<managed) |
| fileSystem | entries | intersection (access 좁히기 포함) |
| sandbox | osSandbox | MRW (none<active) |
| sandbox | readOnly | OR |
| sandbox | workspaceWrite | AND |
| sandbox | networkIsolated | OR |
| control | managedBy | MRW = max(user<team<admin) |
| control | auditRequired | OR |

**불변식 (테스트로 봉인)**: `resolve(child)`는 어떤 axis에서도 `resolve(base)`보다 **넓을 수 없다**
(monotone-narrowing). 즉 derived는 항상 base의 **subset** 권한.

### 5.4 알고리즘 (cycle detection + 해소)

```
resolveProfileInheritance(name, registry, opts):
  builtins = opts.builtins ?? NAMED_PROFILES
  visiting = ordered set (path stack)      # cycle detection
  cache    = Map<string, PermissionProfile> # 중복 base 재계산 방지(deep chains)

  function resolve(n):
    if cache.has(n): return cache.get(n)
    if visiting.has(n):
      THROW "permission profile inheritance cycle detected: " + [...visiting, n].join(" -> ")
    visiting.add(n)

    def = registry[n]
    if def is undefined:
      # registry에 없으면 built-in에서 찾는다(built-in은 완성형 → extends 없음)
      builtin = builtins[n]
      if builtin is undefined:
        THROW "permission profile '"+n+"' extends undefined profile '"+n+"'"  # fail-closed
      visiting.delete(n); cache.set(n, builtin); return builtin

    # extends 정규화: undefined → [], string → [s]
    bases = normalize(def.extends)
    # self-extend 즉시 차단(빠른 경로; visiting로도 잡히지만 메시지 명확)
    if bases includes n: THROW "permission profile '"+n+"' cannot extend itself"

    # base 누적 merge (left-to-right)
    acc = DEFAULT_PERMISSION_PROFILE            # base 없으면 locked-down에서 시작
    for b in bases: acc = mergeProfile(acc, asDefinition(resolve(b)))
    # 자기 자신의 own fields를 마지막에 override-narrow
    result = mergeProfile(acc, def)

    # Managed ceiling: bases 중 tag=managed가 있으면 그 해소값이 ceiling
    managedCeiling = strongest managed base among resolved bases (by §5.6)
    if managedCeiling != undefined:
      breach = widerThan(result, managedCeiling)   # axis별 비교(§5.6)
      if breach: 
        if opts.onManagedWiden == "throw": THROW "... widens managed ceiling: "+breach
        else: result = clampTo(result, managedCeiling)  # 기본: 좁힘

    visiting.delete(n); cache.set(n, result); return result

  return resolve(name)
```

- **total**: 모든 경로가 `PermissionProfile` 반환 또는 THROW. 부분 상태 없음.
- **pure**: `registry`/`builtins`는 인자. 전역 mutable 없음(`visiting`/`cache`는 호출 내 로컬).
- **fail-closed**: unknown base/cycle/self-extend = THROW. base 없으면 `DEFAULT`(locked-down)에서 시작.

### 5.5 순수성 — special-path entries intersection

`access-check.ts`의 `containsPath`는 절대경로 비교용이고 special-path는 resolver가 필요하다.
resolver는 I/O 포트를 품으므로 **resolver를 끌어들이면 순수성 깨짐**. 따라서 entries intersection은
**resolver-free 보수적 비교**를 쓴다:

- `special` vs `special`: `kind` 동일 → 동일 path로 간주.
- `path` vs `path`: 절대경로면 `containsPath` 순수 부분(resolve/relative — node:path는 순수) 사용.
- `special` vs `path` (혼합): 보수적으로 "포함 안 됨"으로 간주 → derived entry 탈락(좁히기 방향이라 안전).
- access cover: `coversAccess` 규칙 재사용(`write`가 `read` cover).

→ 이렇게 하면 resolver 없이도 entries intersection이 **항상 base의 subset**임이 보장(fail-closed).

### 5.6 Tagging — Managed ceiling

- `ProfileDefinition.tag`: `"managed"`(org/MDM) vs `"external"`(user). 미지정 ⇒ `"external"`.
- Codex `TaggedPermissionProfile::Managed/::External` 흡수. quanta 4-scope precedence
  (`managed>project>user>open`, `permission-profile.ts:154-159`)와 정합: `managed` tag profile은
  derived가 **넓힐 수 없는 ceiling**이다.
- ceiling 비교(`widerThan`): §5.3 표의 MRW 축들을 그대로 사용 — result가 ceiling보다 *넓은* axis가 하나라도
  있으면 breach. `clampTo`는 그 axis를 ceiling 값으로 좁힌다(= mergeProfile(result, asDefinition(ceiling))와 동치이되
  ceiling이 강제 우선이 되도록 MRW 적용).
- `control.managedBy`와의 관계: `tag`는 **정의의 출처**(누가 작성했나), `managedBy`는 **profile이 표현하는
  관리 주체**. 둘은 직교하되, `tag=managed`이면 결과의 `control.managedBy`는 최소 `team`으로 승격하지 않는다
  (의미 변경 방지) — tag는 *merge 제약*만 건다.

---

## 6. Backward-compat

- 기존 `NAMED_PROFILES` 3개는 `extends` 없는 완성형 → `resolveProfileInheritance("default", {})`는
  `builtins["default"]` = `DEFAULT_PERMISSION_PROFILE`를 그대로 반환. **byte-identical**.
- `resolveProfileByName`(`named-profiles.ts:103`)는 **변경 없음**. 신규 resolver는 별 파일·별 진입점.
- unknown name: built-in에도 registry에도 없으면 THROW — 기존 fail-closed 보존.
- envelope `permission_profile`: 기존 enum/struct union 유지. `ProfileDefinition.extends`는
  **새 optional 필드**로만 추가(필수화 금지) → 옛 세션 디코드 무영향.
- `profile-list-select.ts`/`exceedsCeiling`: 변경 없음(직교). registry 빌드 시 user definition을 합칠 뿐.

---

## 7. Integration (slot-in 위치)

resolver는 **profile 적용 *전*** 단계다. 적용은 기존 경로 그대로:

1. **registry 빌드**(호출자/composition root): built-in(`NAMED_PROFILES`) + user definition(파일에서 로딩된 partial)을
   `ProfileDefinitionRegistry`로 합친다. built-in 이름은 authoritative(user가 shadow 못 함 — `profile-list-select.ts:189-195` 정책 재사용).
2. **해소**: `resolveProfileInheritance(name, registry)` → 완성된 `PermissionProfile`.
3. **적용**: 그 struct를 `TwoLayerManager.setPermissionProfile(threadId, profile)`
   (`two-layer-manager.ts:116-120`)로 넘긴다. 기존 `setPermissionProfileByName`은 **그대로** 유지.
4. **envelope**: `permission_profile`이 name이면, 디코더가 registry 기반으로 해소(있을 때만);
   registry 없으면 기존 `resolveProfileByName` 경로(backward-compat).

신규 sugar(선택): `TwoLayerManager.setPermissionProfileFromRegistry(threadId, name, registry)` —
resolve→set 한 줄. 기존 메서드 불변(추가만).

---

## 8. Edge cases (전부 테스트로 봉인 — §9)

| case | 동작 |
|---|---|
| cycle `A→B→A` | THROW `inheritance cycle detected: A -> B -> A` |
| self-extend `A extends A` | THROW `cannot extend itself` (visiting로도 잡힘, 빠른 메시지) |
| extends-unknown `A extends "ghost"` | THROW `extends undefined profile 'ghost'` (fail-closed) |
| deep chain `A→B→C→…(N)` | 정상 해소; `cache`로 중복 base 1회만 계산 |
| diamond `D extends [A,B]`, 둘 다 `extends X` | X 1회 계산(cache), A·B 좌→우 순서로 merge |
| managed 넓히기 시도 | 기본 `clamp`(좁힘) / `onManagedWiden:"throw"`면 THROW |
| empty extends `extends: []` / `undefined` | base 없음 → `DEFAULT_PERMISSION_PROFILE`에서 시작, own fields override |
| built-in extend | built-in은 완성형·extends 없음 → derived가 built-in을 base로 두는 건 정상 |
| derived가 network 넓히기 (`restricted`+allow-all) | MRW로 base의 `deny-all` 유지(넓히기 무시) |
| derived가 network 좁히기 (`trusted`+deny-all) | OW/MRW로 `deny-all` 채택 — **핵심 use-case 성공** |
| derived가 entries 추가 | intersection이라 추가분 탈락(넓히기 금지) |
| derived가 빈 entries | 전부 막힘(가장 좁음) |

---

## 9. Test plan (hellgate — adversarial)

신규: `src/permission/__tests__/profile-inheritance-hellgate.test.ts`

1. **single extend per-axis merge**: `trusted extends`로 network만 deny-all 좁히기 →
   결과: network=deny-all, 나머지 trusted 그대로. (use-case 증명)
2. **network MRW**: base `allow-all`, derived `allow-list` → allow-list. base `deny-all`, derived `allow-all` → **deny-all**(넓히기 무시).
3. **approval MRW**: base `auto`, derived `always` → always; base `always`, derived `auto` → **always**. `promptUser` OR.
4. **fileSystem entries intersection**: base에 project-write, derived가 root-write 추가 → root 탈락, project만. access 좁히기(write→read).
5. **sandbox per-flag**: workspaceWrite AND / readOnly·networkIsolated OR / osSandbox none↛active.
6. **control MRW**: `managedBy` user↛admin 못 내림; auditRequired OR.
7. **cycle throws**: `A→B→A`, `A→B→C→A` 모두 THROW + 메시지에 경로 포함.
8. **self-extend throws**.
9. **unknown base throws** (fail-closed, silent fallback 없음 단언).
10. **managed ceiling cannot be widened**: tag=managed base + derived가 각 axis 넓히기 시도 →
    clamp 모드 결과는 ceiling subset; throw 모드는 THROW. **derived가 절대 ceiling보다 넓지 않음** 단언.
11. **monotone-narrowing invariant (property-ish)**: 임의 base + 임의 partial derived 묶음에 대해
    `resolve(child)` ⊆ `resolve(base)` (각 axis rank ≤). 표 13개 축 전부.
12. **deep chain (N=20)** 정상 해소 + cache로 O(N).
13. **diamond** 일관성 (A,B가 같은 X 상속 → X 1회, 결과 결정적).
14. **regression — 기존 3 profile 불변**: `resolveProfileInheritance("default"/"restricted"/"trusted", {})`가
    `NAMED_PROFILES[name]`와 **deep-equal**(byte-identical). `resolveProfileByName` 동작 무변경.
15. **empty extends / undefined extends** → DEFAULT 기반.

목표: 0 fail, tsc 0, biome 0 (slice 기준).

---

## 10. File-by-file 변경 목록

| 파일 | 변경 |
|---|---|
| `src/permission/profile-inheritance.ts` | **신규(leaf)**. `ProfileTag`/`ProfileDefinition`/`ProfileDefinitionRegistry`/`ResolveInheritanceOpts` 타입 + `resolveProfileInheritance` + 내부 `mergeProfile`/`asDefinition`/`widerThan`/`clampTo` + axis rank consts(network rank는 `profile-list-select.ts`의 `NETWORK_RANK`를 export화해 재사용). **순수·무 I/O** |
| `src/permission/profile-list-select.ts` | `NETWORK_RANK`를 export(또는 공용 const로 추출)해 inheritance가 재사용. `parseUserProfile` 변경 **없음** (definition 파서는 별도 함수 `parseUserProfileDefinition`를 신규로 추가 — partial 허용; 기존 strict 파서 불변) |
| `src/permission/named-profiles.ts` | 변경 없음(읽기 전용으로 builtins 제공). 선택: `asDefinition` 헬퍼 export |
| `src/permission/two-layer-manager.ts` | **추가만**: `setPermissionProfileFromRegistry(threadId, name, registry)` sugar. 기존 메서드 불변 |
| `src/permission/index.ts` | 신규 심볼 barrel export (`resolveProfileInheritance`, 타입들) |
| `src/session/envelope.ts` | (선택, 별 슬라이스화 가능) `PermissionProfileStructSchema`에 `extends?`/`tag?` optional 추가 — backward-compat. 미적용 시 registry는 코드 측에서만 구성 |
| `src/permission/__tests__/profile-inheritance-hellgate.test.ts` | **신규** §9 |
| `docs/decisions/0435-permission-profile-inheritance.md` | **신규 ADR** |
| feature catalog row | inheritance 한 줄 추가 |

슬라이스 fence: 신규 파일은 `permission-profile.ts`(순수 타입) + `access-check.ts`의 순수 부분 +
`named-profiles.ts`만 의존. I/O·store·gate 무의존.

---

## 11. ADR 제안

- **번호**: `docs/decisions/0435-permission-profile-inheritance.md` (0435+ free 확인).
- **제목**: "Permission-profile inheritance (`extends` + cycle detection + Managed tagging)".
- **핵심 결정**: (1) 합성은 *해소 단계*에서만(적용 경로 plane-clean), (2) merge는 **monotone-narrowing**
  (넓히기 금지, 좁히기 자유), (3) cycle/unknown/self-extend = **THROW**(Codex fail-closed),
  (4) Managed tag = ceiling(External이 못 넓힘), (5) resolver는 **순수·전역·무 I/O**, default-OFF.
- **Alternatives 기록**: union-merge(거부 — 권한 넓히기 위험), resolver에 special-path resolver 주입
  (거부 — 순수성 깨짐; resolver-free 보수 비교 채택), `extends` envelope 필수화(거부 — backward-compat).

---

## 12. Effort

- `profile-inheritance.ts` 코어(타입+resolver+merge 13축+cycle): ~250–320 LOC. **M**.
- hellgate 15 케이스: ~250 LOC. **M**.
- `two-layer-manager` sugar + barrel + `NETWORK_RANK` 추출: **S**.
- envelope optional 필드(선택, 분리 가능): **S**.
- ADR + catalog: **S**.
- **총합: M (1 슬라이스, 1일 내).** worktree-isolated agent 1명 + cherry-pick에 적합.

---

## 13. SOTA++ 체크리스트

- [x] **pure / total** resolver — registry 인자, 전역 mutable 없음, 모든 입력에 반환 OR THROW.
- [x] **no I/O** — special-path resolver 미주입(보수 비교), disk 미접근.
- [x] **fail-closed** — cycle/unknown/self-extend THROW; base 없으면 locked-down DEFAULT 시작.
- [x] **monotone-narrowing invariant** — derived ⊆ base, 13축 테스트 봉인.
- [x] **Managed ceiling** — Codex `TaggedPermissionProfile::Managed/::External` 흡수, 4-scope precedence 정합.
- [x] **exact merge semantics** — §5.3 axis×field 표로 문서화.
- [x] **slice-fenced** — leaf, 순수 의존만.
- [x] **default-OFF / backward-compat** — 기존 3 profile byte-identical, unknown fail-closed 보존, `extends` optional.
