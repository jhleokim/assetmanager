import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveKey, deriveKeyFor, seal, open, randomSalt, makeVerifier,
         checkPassphrase, KDF } from "./crypto.js";
import { toB64, fromB64, timingSafeEqual } from "./bytes.js";

// 테스트 속도를 위해 반복을 줄인다 — 알고리즘은 동일
const FAST = 1000;

describe("bytes", () => {
  test("base64 왕복", () => {
    const b = new Uint8Array([0, 1, 127, 128, 255]);
    assert.deepEqual(fromB64(toB64(b)), b);
  });
  test("timingSafeEqual", () => {
    assert.ok(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])));
    assert.ok(!timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])));
    assert.ok(!timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])));
  });
});

describe("종단간 암호화", () => {
  const data = { assets: [{ id: 1, name: "송도 자택 아파트", value: 920e6, acct: "****1234" }],
                 trades: [], hist: {} };

  test("암호화 → 복호화 왕복", async () => {
    const salt = randomSalt();
    const key = await deriveKey("가족 잠금 암호 2026", salt, FAST);
    const env = await seal(key, data, { salt, iterations: FAST });
    const back = await open(key, env);
    assert.deepEqual(back, data);
  });

  test("봉투에는 키나 평문이 없다", async () => {
    const salt = randomSalt();
    const key = await deriveKey("pw", salt, FAST);
    const env = await seal(key, data, { salt, iterations: FAST });
    const s = JSON.stringify(env);
    assert.ok(!s.includes("송도"), "자산명이 평문으로 남아 있다");
    assert.ok(!s.includes("920000000"), "금액이 평문으로 남아 있다");
    assert.ok(!s.includes("pw"), "암호가 들어 있다");
    assert.deepEqual(Object.keys(env).sort(), ["ct", "iv", "kdf", "v"]);
  });

  test("다른 기기: 봉투의 kdf 정보만으로 키를 재파생해 연다", async () => {
    const salt = randomSalt();
    const key1 = await deriveKey("secret", salt, FAST);
    const env = await seal(key1, data, { salt, iterations: FAST });
    const key2 = await deriveKeyFor("secret", env);     // salt를 따로 전달하지 않는다
    assert.deepEqual(await open(key2, env), data);
  });

  test("틀린 암호는 복호화에 실패한다 (GCM 태그)", async () => {
    const salt = randomSalt();
    const key = await deriveKey("right", salt, FAST);
    const env = await seal(key, data, { salt, iterations: FAST });
    const wrong = await deriveKeyFor("wrong", env);
    await assert.rejects(open(wrong, env), /복호화 실패/);
  });

  test("암호문이 1바이트라도 바뀌면 열리지 않는다 (무결성)", async () => {
    const salt = randomSalt();
    const key = await deriveKey("pw", salt, FAST);
    const env = await seal(key, data, { salt, iterations: FAST });
    const ct = fromB64(env.ct);
    ct[10] ^= 0x01;
    await assert.rejects(open(key, { ...env, ct: toB64(ct) }), /복호화 실패/);
  });

  test("같은 데이터를 두 번 암호화하면 iv·암호문이 다르다", async () => {
    const salt = randomSalt();
    const key = await deriveKey("pw", salt, FAST);
    const a = await seal(key, data, { salt, iterations: FAST });
    const b = await seal(key, data, { salt, iterations: FAST });
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  test("잠금 암호 검증기", async () => {
    const salt = randomSalt();
    const key = await deriveKey("family", salt, FAST);
    const v = await makeVerifier(key, salt);
    v.kdf.iterations = FAST;
    assert.equal(await checkPassphrase("family", v), true);
    assert.equal(await checkPassphrase("Family", v), false);
  });

  test("기본 반복 횟수는 OWASP 권장치", () => {
    assert.equal(KDF.iterations, 600_000);
  });

  test("빈 암호는 거부", async () => {
    await assert.rejects(deriveKey("", randomSalt(), FAST), /비어/);
  });
});
