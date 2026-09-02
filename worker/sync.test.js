import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1-test.js";
import { ensureUser, householdsFor, memberRole, getVault, putVault, invite } from "./sync.js";

const SCHEMA = new URL("./schema.sql", import.meta.url).pathname;
const ENV = { v: 1, kdf: { alg: "PBKDF2-SHA256", iterations: 600000, salt: "c2FsdA==" }, iv: "aXY=", ct: "Y3Q=" };

describe("사용자·가구 부트스트랩", () => {
  test("첫 로그인이 사용자와 가구를 만든다", async () => {
    const db = makeD1(SCHEMA);
    const u = await ensureUser(db, "Dad@Example.com");
    assert.equal(u.email, "dad@example.com");
    const hs = await householdsFor(db, u, { saltB64: "c2FsdA==" });
    assert.equal(hs.length, 1);
    assert.equal(hs[0].role, "owner");
    assert.equal(await memberRole(db, hs[0].id, u.id), "owner");
    assert.deepEqual(await getVault(db, hs[0].id), { version: 0, envelope: null, updatedAt: null, updatedBy: null });
  });

  test("두 번째 로그인은 새 가구를 만들지 않는다", async () => {
    const db = makeD1(SCHEMA);
    const u = await ensureUser(db, "a@x.com");
    await householdsFor(db, u, { saltB64: "s" });
    const again = await householdsFor(db, await ensureUser(db, "a@x.com"), { saltB64: "s2" });
    assert.equal(again.length, 1);
  });

  test("초대된 이메일은 가입 즉시 그 가구에 합류한다", async () => {
    const db = makeD1(SCHEMA);
    const owner = await ensureUser(db, "owner@x.com");
    const [h] = await householdsFor(db, owner, { saltB64: "s" });
    const r = await invite(db, h.id, owner.id, "Spouse@X.com", "editor");
    assert.equal(r.joined, false);
    const spouse = await ensureUser(db, "spouse@x.com");
    assert.equal(await memberRole(db, h.id, spouse.id), "editor");
    const hs = await householdsFor(db, spouse, { createIfNone: false });
    assert.equal(hs.length, 1, "자기 가구를 따로 만들지 않고 초대된 가구에 들어간다");
  });

  test("이미 가입한 사용자를 초대하면 즉시 합류", async () => {
    const db = makeD1(SCHEMA);
    const owner = await ensureUser(db, "o@x.com");
    const [h] = await householdsFor(db, owner, { saltB64: "s" });
    const kid = await ensureUser(db, "kid@x.com");
    const r = await invite(db, h.id, owner.id, "kid@x.com", "viewer");
    assert.equal(r.joined, true);
    assert.equal(await memberRole(db, h.id, kid.id), "viewer");
  });

  test("owner 역할로는 초대할 수 없다", async () => {
    const db = makeD1(SCHEMA);
    const owner = await ensureUser(db, "o@x.com");
    const [h] = await householdsFor(db, owner, { saltB64: "s" });
    assert.equal((await invite(db, h.id, owner.id, "x@x.com", "owner")).status, 400);
  });
});

describe("봉투 동기화 — 낙관적 동시성", () => {
  async function setup(){
    const db = makeD1(SCHEMA);
    const u = await ensureUser(db, "u@x.com");
    const [h] = await householdsFor(db, u, { saltB64: "s" });
    return { db, u, h };
  }

  test("저장 → 버전 증가 → 읽기", async () => {
    const { db, u, h } = await setup();
    const r = await putVault(db, h.id, u.id, { baseVersion: 0, envelope: ENV });
    assert.equal(r.status, 200);
    assert.equal(r.version, 1);
    const v = await getVault(db, h.id);
    assert.equal(v.version, 1);
    assert.deepEqual(v.envelope, ENV);
    assert.equal(v.updatedBy, u.id);
  });

  test("낡은 baseVersion으로 쓰면 409 (다른 기기가 먼저 저장)", async () => {
    const { db, u, h } = await setup();
    await putVault(db, h.id, u.id, { baseVersion: 0, envelope: ENV });          // 기기 A
    const r = await putVault(db, h.id, u.id, { baseVersion: 0, envelope: ENV }); // 기기 B, 낡은 버전
    assert.equal(r.status, 409);
    assert.equal(r.version, 1, "현재 버전을 알려줘 다시 시도하게 한다");
    assert.equal((await getVault(db, h.id)).version, 1, "덮어쓰지 않았다");
  });

  test("형식이 아닌 봉투는 400", async () => {
    const { db, u, h } = await setup();
    assert.equal((await putVault(db, h.id, u.id, { baseVersion: 0, envelope: { foo: 1 } })).status, 400);
    assert.equal((await putVault(db, h.id, u.id, { baseVersion: 0, envelope: null })).status, 400);
  });

  test("서버에 평문이 저장되지 않는다 — 봉투 문자열 그대로만", async () => {
    const { db, u, h } = await setup();
    await putVault(db, h.id, u.id, { baseVersion: 0, envelope: ENV });
    const raw = db._raw.prepare("SELECT envelope FROM vaults WHERE household_id = ?").get(h.id).envelope;
    assert.equal(raw, JSON.stringify(ENV));
    assert.equal(db._raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'").get(), undefined,
      "assets 테이블이 존재하면 안 된다 (DATA-PRIVACY.md)");
  });
});
