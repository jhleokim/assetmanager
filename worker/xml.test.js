import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRtms, normalizeDeal, tagText } from "./xml.js";

const OK = `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header>
<body><items>
<item><aptNm>송도더샵</aptNm><dealAmount> 92,000</dealAmount><dealYear>2026</dealYear><dealMonth>8</dealMonth><dealDay>14</dealDay><excluUseAr>84.98</excluUseAr><floor>12</floor><umdNm>송도동</umdNm></item>
<item><aptNm><![CDATA[힐스테이트 &amp; 레이크]]></aptNm><dealAmount>110,500</dealAmount><dealYear>2026</dealYear><dealMonth>8</dealMonth><dealDay>3</dealDay><excluUseAr>101.2</excluUseAr><floor>25</floor><umdNm>송도동</umdNm></item>
</items><numOfRows>500</numOfRows><pageNo>1</pageNo><totalCount>1234</totalCount></body></response>`;

describe("parseRtms", () => {
  test("정상 응답에서 item·totalCount를 읽는다", () => {
    const r = parseRtms(OK);
    assert.equal(r.items.length, 2);
    assert.equal(r.totalCount, 1234);
    assert.equal(r.numOfRows, 500);
    assert.equal(r.items[0].aptNm, "송도더샵");
  });

  test("CDATA와 엔티티를 푼다", () => {
    assert.equal(parseRtms(OK).items[1].aptNm, "힐스테이트 & 레이크");
  });

  test("HTML 오류 페이지는 '거래 없음'이 아니라 오류다 (P1-5b 회귀)", () => {
    const html = `<!DOCTYPE html><html><body><h1>429 Too Many Requests</h1></body></html>`;
    assert.throws(() => parseRtms(html), /XML이 아닌 응답.*429/);
  });

  test("빈 응답도 오류", () => {
    assert.throws(() => parseRtms(""), /빈 응답/);
  });

  test("공공데이터포털 인증 오류 형식", () => {
    const err = `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>
      <returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode>
      </cmmMsgHeader></OpenAPI_ServiceResponse>`;
    assert.throws(() => parseRtms(err), /공공데이터포털 오류.*30/);
  });

  test("resultCode가 00/000이 아니면 오류", () => {
    const bad = `<response><header><resultCode>03</resultCode><resultMsg>NODATA_ERROR</resultMsg></header><body/></response>`;
    assert.throws(() => parseRtms(bad), /오류 03 NODATA_ERROR/);
  });

  test("resultCode 00 도 정상으로 본다", () => {
    const r = parseRtms(`<response><header><resultCode>00</resultCode></header><body><items/></body></response>`);
    assert.equal(r.items.length, 0);
  });
});

describe("normalizeDeal", () => {
  test("만원 단위 거래금액을 원으로, ㎡단가를 만원으로", () => {
    const d = normalizeDeal(parseRtms(OK).items[0], "202608");
    assert.equal(d.date, "2026-08-14");
    assert.equal(d.amount, 920_000_000);
    assert.equal(d.area, 84.98);
    assert.ok(Math.abs(d.unit - 92000 / 84.98) < 0.01);
    assert.equal(d.floor, "12");
  });
  test("거래금액 없는 항목은 null", () => {
    assert.equal(normalizeDeal({ aptNm: "x" }, "202608"), null);
  });
  test("날짜 필드가 없으면 조회월 1일", () => {
    assert.equal(normalizeDeal({ dealAmount: "1,000" }, "202608").date, "2026-08-01");
  });
});

describe("tagText", () => {
  test("속성이 있는 태그도 읽는다", () => {
    assert.equal(tagText(`<a x="1">v</a>`, "a"), "v");
  });
});
