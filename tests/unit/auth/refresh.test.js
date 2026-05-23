import { afterEach, describe, expect, test } from "bun:test";
import { __resetInflightForTest, exchangeCode, RefreshCoordinator, refreshToken, TokenExchangeError, } from "../../../src/auth/chatgpt-oauth/refresh";
afterEach(() => {
    __resetInflightForTest();
});
const cfg = {
    issuer: "https://auth.example.test",
    clientId: "client_xyz",
    apiBase: "https://api.example.test",
    sku: "QUANTA",
    originator: "quanta-test",
};
const FIXED_NOW = Date.parse("2026-05-23T00:00:00.000Z");
const now = () => FIXED_NOW;
const toBase64Url = (s) => Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const fakeIdToken = (planType, accountId) => {
    const header = toBase64Url('{"alg":"RS256"}');
    const body = toBase64Url(JSON.stringify({
        "https://api.openai.com/auth": {
            chatgpt_plan_type: planType,
            chatgpt_account_id: accountId,
        },
    }));
    return `${header}.${body}.sig`;
};
const mockResponse = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
});
describe("refresh.exchangeCode", () => {
    test("happy path: builds TokenRecord with id_token-derived plan/account", async () => {
        const idToken = fakeIdToken("plus", "acct-1");
        const fetchImpl = async () => mockResponse(200, {
            access_token: "at-x",
            refresh_token: "rt-x",
            id_token: idToken,
            expires_in: 3600,
        });
        const rec = await exchangeCode({
            cfg,
            code: "code-1",
            verifier: "verifier-1",
            redirectUri: "http://127.0.0.1:1455/auth/callback",
            fetchImpl,
            nowMs: now,
        });
        expect(rec.access_token).toBe("at-x");
        expect(rec.refresh_token).toBe("rt-x");
        expect(rec.id_token).toBe(idToken);
        expect(rec.plan_type).toBe("plus");
        expect(rec.account_id).toBe("acct-1");
        expect(Date.parse(rec.expires_at)).toBe(FIXED_NOW + 3600 * 1000);
        expect(rec.last_refresh).toBe(new Date(FIXED_NOW).toISOString());
    });
    test("missing refresh_token throws shape error", async () => {
        const fetchImpl = async () => mockResponse(200, { access_token: "at" });
        await expect(exchangeCode({
            cfg,
            code: "c",
            verifier: "v",
            redirectUri: "r",
            fetchImpl,
            nowMs: now,
        })).rejects.toThrow(TokenExchangeError);
    });
    test("non-2xx surfaces issuer error code + description", async () => {
        const fetchImpl = async () => mockResponse(400, { error: "invalid_grant", error_description: "code expired" });
        try {
            await exchangeCode({
                cfg,
                code: "c",
                verifier: "v",
                redirectUri: "r",
                fetchImpl,
                nowMs: now,
            });
            throw new Error("expected throw");
        }
        catch (e) {
            expect(e).toBeInstanceOf(TokenExchangeError);
            const te = e;
            expect(te.statusCode).toBe(400);
            expect(te.errorCode).toBe("invalid_grant");
            expect(te.description).toBe("code expired");
        }
    });
    test("decode failure on id_token does NOT fail the exchange (plan=unknown)", async () => {
        const fetchImpl = async () => mockResponse(200, {
            access_token: "at",
            refresh_token: "rt",
            id_token: "garbage.not.jwt",
            expires_in: 60,
        });
        const rec = await exchangeCode({
            cfg,
            code: "c",
            verifier: "v",
            redirectUri: "r",
            fetchImpl,
            nowMs: now,
        });
        expect(rec.plan_type).toBeUndefined();
        expect(rec.account_id).toBeUndefined();
    });
});
describe("refresh.refreshToken", () => {
    const seed = {
        access_token: "at-old",
        refresh_token: "rt-static",
        expires_at: new Date(FIXED_NOW + 60_000).toISOString(),
    };
    test("reuses previous refresh_token when response omits one", async () => {
        const fetchImpl = async () => mockResponse(200, { access_token: "at-new", expires_in: 3600 });
        const rec = await refreshToken({ cfg, current: seed, fetchImpl, nowMs: now });
        expect(rec.access_token).toBe("at-new");
        expect(rec.refresh_token).toBe("rt-static");
    });
    test("in-flight guard: two concurrent refreshes hit the issuer ONCE", async () => {
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            await new Promise((r) => setTimeout(r, 10));
            return mockResponse(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 60 });
        };
        const [a, b] = await Promise.all([
            refreshToken({ cfg, current: seed, fetchImpl, nowMs: now }),
            refreshToken({ cfg, current: seed, fetchImpl, nowMs: now }),
        ]);
        expect(calls).toBe(1);
        expect(a.access_token).toBe("at-new");
        expect(b.access_token).toBe("at-new");
    });
    test("different refresh_tokens do NOT share in-flight slots", async () => {
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            await new Promise((r) => setTimeout(r, 5));
            return mockResponse(200, { access_token: `at-${calls}`, expires_in: 60 });
        };
        const seedA = { ...seed, refresh_token: "rt-A" };
        const seedB = { ...seed, refresh_token: "rt-B" };
        await Promise.all([
            refreshToken({ cfg, current: seedA, fetchImpl, nowMs: now }),
            refreshToken({ cfg, current: seedB, fetchImpl, nowMs: now }),
        ]);
        expect(calls).toBe(2);
    });
});
describe("refresh.RefreshCoordinator", () => {
    const seed = {
        access_token: "at-old",
        refresh_token: "rt-static",
        expires_at: new Date(FIXED_NOW + 60_000).toISOString(),
    };
    test("instances hold isolated in-flight tables (no cross-instance dedup)", async () => {
        // Instance A's refresh is mid-flight; instance B with the same key must
        // start its own request. Cross-adapter leakage would collapse calls=2 → 1.
        const gateA = Promise.withResolvers();
        const gateB = Promise.withResolvers();
        let aCalls = 0;
        let bCalls = 0;
        const fetchA = async () => {
            aCalls += 1;
            await gateA.promise;
            return mockResponse(200, { access_token: "at-A", expires_in: 60 });
        };
        const fetchB = async () => {
            bCalls += 1;
            await gateB.promise;
            return mockResponse(200, { access_token: "at-B", expires_in: 60 });
        };
        const coordA = new RefreshCoordinator();
        const coordB = new RefreshCoordinator();
        const pA = coordA.refresh({ cfg, current: seed, fetchImpl: fetchA, nowMs: now });
        const pB = coordB.refresh({ cfg, current: seed, fetchImpl: fetchB, nowMs: now });
        // Both have entered their own in-flight slot — proves separate tables.
        expect(coordA.__sizeForTest()).toBe(1);
        expect(coordB.__sizeForTest()).toBe(1);
        gateA.resolve();
        gateB.resolve();
        const [recA, recB] = await Promise.all([pA, pB]);
        expect(aCalls).toBe(1);
        expect(bCalls).toBe(1);
        expect(recA.access_token).toBe("at-A");
        expect(recB.access_token).toBe("at-B");
    });
    test("in-flight slot is released on resolve (no memory leak)", async () => {
        const coord = new RefreshCoordinator();
        const fetchImpl = async () => mockResponse(200, { access_token: "at-ok", expires_in: 60 });
        await coord.refresh({ cfg, current: seed, fetchImpl, nowMs: now });
        expect(coord.__sizeForTest()).toBe(0);
    });
    test("in-flight slot is released on reject (no memory leak)", async () => {
        const coord = new RefreshCoordinator();
        const fetchImpl = async () => mockResponse(400, { error: "invalid_grant", error_description: "revoked" });
        await expect(coord.refresh({ cfg, current: seed, fetchImpl, nowMs: now })).rejects.toThrow(TokenExchangeError);
        expect(coord.__sizeForTest()).toBe(0);
    });
    test("__reset() clears in-flight slots without disturbing other instances", async () => {
        const gate = Promise.withResolvers();
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            await gate.promise;
            return mockResponse(200, { access_token: "at", expires_in: 60 });
        };
        const coordA = new RefreshCoordinator();
        const coordB = new RefreshCoordinator();
        const pA = coordA.refresh({ cfg, current: seed, fetchImpl, nowMs: now });
        const pB = coordB.refresh({ cfg, current: seed, fetchImpl, nowMs: now });
        expect(coordA.__sizeForTest()).toBe(1);
        expect(coordB.__sizeForTest()).toBe(1);
        coordA.__reset();
        expect(coordA.__sizeForTest()).toBe(0);
        expect(coordB.__sizeForTest()).toBe(1); // B untouched
        gate.resolve();
        await Promise.all([pA, pB]);
        expect(calls).toBe(2);
    });
    test("default refreshToken() and __resetInflightForTest() still target the shared default coordinator", async () => {
        // Backwards-compat smoke: the module-level wrapper continues to dedup
        // across calls, and the legacy reset seam still works.
        const gate = Promise.withResolvers();
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            await gate.promise;
            return mockResponse(200, { access_token: "at-default", expires_in: 60 });
        };
        const p1 = refreshToken({ cfg, current: seed, fetchImpl, nowMs: now });
        const p2 = refreshToken({ cfg, current: seed, fetchImpl, nowMs: now });
        gate.resolve();
        await Promise.all([p1, p2]);
        expect(calls).toBe(1); // dedup at default coordinator
        // Legacy seam clears without crashing; reset is idempotent on an empty map.
        __resetInflightForTest();
        __resetInflightForTest();
    });
});
