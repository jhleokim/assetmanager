import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, fetchWithTimeout, isClosedMonth, recentMonths } from "./pool.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe("pool", () => {
  test("동시 실행 수가 limit를 넘지 않는다", async () => {
    let running = 0, peak = 0;
    await pool(Array(12).fill(0), async () => {
      running++; peak = Math.max(peak, running);
      await sleep(5);
      running--;
    }, 4);
    assert.equal(peak, 4);
  });

  test("결과는 입력 순서를 지킨다", async () => {
    const r = await pool([30, 5, 15], async ms => { await sleep(ms); return ms; }, 3);
    assert.deepEqual(r.map(x => x.value), [30, 5, 15]);
  });

  test("개별 실패가 나머지를 막지 않는다", async () => {
    const r = await pool([1, 2, 3], async n => { if(n === 2) throw new Error("boom"); return n; }, 2);
    assert.equal(r[0].ok, true);
    assert.equal(r[1].ok, false);
    assert.match(r[1].error.message, /boom/);
    assert.equal(r[2].value, 3);
  });

  test("13개를 5개씩 → 3웨이브 (NETWORK.md 추정 검증)", async () => {
    let waves = 0, inWave = 0;
    await pool(Array(13).fill(0), async () => {
      if(inWave === 0) waves++;
      inWave++;
      await sleep(10);
      inWave--;
    }, 5);
    assert.ok(waves <= 3, `웨이브 ${waves}`);
  });

  test("빈 입력", async () => {
    assert.deepEqual(await pool([], async () => 1, 5), []);
  });
});

describe("fetchWithTimeout", () => {
  test("시간 초과 시 AbortError를 사람이 읽을 메시지로 바꾼다", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (_, { signal }) => new Promise((_, rej) =>
      signal.addEventListener("abort", () => { const e = new Error(); e.name = "AbortError"; rej(e); }));
    try{
      await assert.rejects(fetchWithTimeout("http://x", { timeoutMs: 20 }), /시간 초과 \(20ms\)/);
    }finally{ globalThis.fetch = orig; }
  });
});

describe("월 유틸", () => {
  test("isClosedMonth — 이번 달은 열려 있고 지난달은 닫혀 있다", () => {
    assert.equal(isClosedMonth("202608", "2026-09-02"), true);
    assert.equal(isClosedMonth("202609", "2026-09-02"), false);
    assert.equal(isClosedMonth("202610", "2026-09-02"), false);
  });
  test("recentMonths — 연도 경계를 넘는다", () => {
    assert.deepEqual(recentMonths("2026-02-15", 4), ["202602", "202601", "202512", "202511"]);
  });
});
