import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJWT } from "./access.js";

const TEAM = "family.cloudflareaccess.com", AUD = "abc123";
const b64url = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = s => b64url(new TextEncoder().encode(s));

let priv, jwks, sign;
before(async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  priv = kp.privateKey;
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  jwks = [{ ...pub, kid: "k1", use: "sig" }];
  sign = async (payload, header = { alg: "RS256", kid: "k1" }) => {
    const h = enc(JSON.stringify(header)), p = enc(JSON.stringify(payload));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(h + "." + p));
    return h + "." + p + "." + b64url(sig);
  };
});

const now = 1_800_000_000;
const good = () => ({ iss: "https://" + TEAM, aud: [AUD], email: "Mom@Example.com", sub: "u1", exp: now + 600, iat: now });

describe("verifyAccessJWT", () => {
  test("정상 토큰 → 소문자 이메일", async () => {
    const r = await verifyAccessJWT(await sign(good()), { teamDomain: TEAM, aud: AUD, now, jwks });
    assert.equal(r.email, "mom@example.com");
  });
  test("서명 변조", async () => {
    const t = await sign(good());
    const bad = t.slice(0, -4) + "AAAA";
    await assert.rejects(verifyAccessJWT(bad, { teamDomain: TEAM, aud: AUD, now, jwks }), /서명 불일치/);
  });
  test("만료", async () => {
    await assert.rejects(verifyAccessJWT(await sign({ ...good(), exp: now - 1 }), { teamDomain: TEAM, aud: AUD, now, jwks }), /만료/);
  });
  test("다른 팀 도메인", async () => {
    await assert.rejects(verifyAccessJWT(await sign({ ...good(), iss: "https://evil.cloudflareaccess.com" }),
      { teamDomain: TEAM, aud: AUD, now, jwks }), /발급자/);
  });
  test("다른 앱의 토큰(aud)", async () => {
    await assert.rejects(verifyAccessJWT(await sign({ ...good(), aud: ["other"] }), { teamDomain: TEAM, aud: AUD, now, jwks }), /aud/);
  });
  test("alg=none 거부", async () => {
    await assert.rejects(verifyAccessJWT(await sign(good(), { alg: "none", kid: "k1" }), { teamDomain: TEAM, aud: AUD, now, jwks }), /알고리즘/);
  });
  test("모르는 kid", async () => {
    await assert.rejects(verifyAccessJWT(await sign(good(), { alg: "RS256", kid: "zzz" }), { teamDomain: TEAM, aud: AUD, now, jwks }), /kid/);
  });
  test("토큰 없음", async () => {
    await assert.rejects(verifyAccessJWT(null, { teamDomain: TEAM, aud: AUD, now, jwks }), /없습니다/);
  });
});
