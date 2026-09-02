import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { esc, h, table, clear, replace } from "./html.js";

/* ── innerHTML에 손대면 즉시 실패하는 최소 DOM ────────────────────────── */
class Node {
  constructor(){ this.childNodes = []; }
  appendChild(c){ this.childNodes.push(c); c.parentNode = this; return c; }
  removeChild(c){ this.childNodes.splice(this.childNodes.indexOf(c), 1); return c; }
  get firstChild(){ return this.childNodes[0] || null; }
  get nodeType(){ return 1; }
  get innerHTML(){ throw new Error("innerHTML 읽기 금지"); }
  set innerHTML(_){ throw new Error("innerHTML 쓰기 금지"); }
}
class Text extends Node {
  constructor(t){ super(); this.data = String(t); }
  get nodeType(){ return 3; }
  get textContent(){ return this.data; }
}
class Element extends Node {
  constructor(tag){ super(); this.tagName = tag.toUpperCase(); this.attrs = {}; this.style = {}; this.dataset = {}; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return this.attrs[k]; }
  get className(){ return this.attrs.class || ""; }
  set className(v){ this.attrs.class = v; }
  get textContent(){ return this.childNodes.map(c => c.textContent).join(""); }
  /** 직렬화 — 테스트에서 결과를 눈으로 확인하기 위한 것 */
  serialize(){
    const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
    const kids = this.childNodes.map(c => c instanceof Text ? c.data : c.serialize()).join("");
    return `<${this.tagName.toLowerCase()}${a}>${kids}</${this.tagName.toLowerCase()}>`;
  }
  querySelectorAll(){ return []; }
}
globalThis.document = {
  createElement: t => new Element(t),
  createTextNode: t => new Text(t)
};

const PAYLOAD = `<img src=x onerror="alert('xss')">`;

describe("esc", () => {
  test("작은따옴표와 슬래시까지 이스케이프한다 (P2-7 회귀)", () => {
    assert.equal(esc(`a'b`), "a&#39;b");
    assert.equal(esc(`</script>`), "&lt;&#x2F;script&gt;");
    assert.equal(esc(`"x" & 'y'`), "&quot;x&quot; &amp; &#39;y&#39;");
  });
  test("null·undefined는 빈 문자열", () => {
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
  });
});

describe("h — 텍스트는 항상 텍스트 노드다", () => {
  test("자산명에 스크립트가 들어와도 마크업이 되지 않는다", () => {
    const td = h("td", null, PAYLOAD);
    assert.equal(td.childNodes.length, 1);
    assert.equal(td.childNodes[0].nodeType, 3, "텍스트 노드여야 한다");
    assert.equal(td.textContent, PAYLOAD);          // 문자 그대로 보존
  });

  test("on* 속성은 거부한다", () => {
    assert.throws(() => h("a", { onclick: "alert(1)" }), /허용되지 않는 속성/);
    assert.throws(() => h("a", { ONCLICK: "alert(1)" }), /허용되지 않는 속성/);
  });

  test("javascript: URL은 거부한다", () => {
    assert.throws(() => h("a", { href: "javascript:alert(1)" }), /허용되지 않는 URL/);
    assert.throws(() => h("img", { src: "data:text/html,<script>" }), /허용되지 않는 URL/);
    assert.doesNotThrow(() => h("a", { href: "https://example.com" }));
    assert.doesNotThrow(() => h("a", { href: "#top" }));
    assert.doesNotThrow(() => h("a", { href: "/api/x" }));
  });

  test("null·false 속성은 생략, true는 빈 값", () => {
    const el = h("input", { disabled: true, hidden: false, value: null });
    assert.equal(el.getAttribute("disabled"), "");
    assert.equal(el.getAttribute("hidden"), undefined);
    assert.equal(el.getAttribute("value"), undefined);
  });

  test("중첩 배열 자식을 평탄화하고 null은 건너뛴다", () => {
    const tr = h("tr", null, [h("td", null, "a"), null, [h("td", null, "b")]]);
    assert.equal(tr.childNodes.length, 2);
  });
});

describe("table", () => {
  const columns = [
    { key: "name", label: "자산명" },
    { key: "value", label: "평가액", align: "r", render: r => r.value.toLocaleString("ko-KR") },
    { key: "memo", label: "메모", cls: r => r.value < 0 ? "neg" : null }
  ];

  test("악의적 자산명·메모가 텍스트로만 들어간다", () => {
    const t = table({ columns, rows: [{ name: PAYLOAD, value: 100, memo: `'); drop table` }] });
    const tr = t.childNodes[1].childNodes[0];
    assert.equal(tr.childNodes[0].textContent, PAYLOAD);
    assert.equal(tr.childNodes[2].textContent, `'); drop table`);
    assert.ok(t.serialize().includes("&lt;") === false, "이스케이프 문자열이 아니라 진짜 텍스트 노드");
  });

  test("정렬·조건 클래스가 붙는다", () => {
    const t = table({ columns, rows: [{ name: "x", value: -5, memo: "m" }] });
    const tds = t.childNodes[1].childNodes[0].childNodes;
    assert.equal(tds[1].className, "r");
    assert.equal(tds[2].className, "neg");
  });

  test("빈 행은 colspan 안내 행", () => {
    const t = table({ columns, rows: [], empty: "없음" });
    const td = t.childNodes[1].childNodes[0].childNodes[0];
    assert.equal(td.getAttribute("colspan"), "3");
    assert.equal(td.textContent, "없음");
  });

  test("rowAttrs로 data-id를 붙인다", () => {
    const t = table({ columns, rows: [{ id: 7, name: "a", value: 1, memo: "" }],
                      rowAttrs: r => ({ "data-id": r.id }) });
    assert.equal(t.childNodes[1].childNodes[0].getAttribute("data-id"), "7");
  });

  test("tfoot", () => {
    const t = table({ columns, rows: [], foot: ["합계", { text: "1,000", attrs: { class: "r" } }, ""] });
    assert.equal(t.childNodes[2].tagName, "TFOOT");
    assert.equal(t.childNodes[2].childNodes[0].childNodes[1].className, "r");
  });
});

describe("clear / replace", () => {
  test("innerHTML 없이 비운다", () => {
    const d = h("div", null, "a", "b");
    clear(d);
    assert.equal(d.childNodes.length, 0);
    replace(d, h("span", null, "c"));
    assert.equal(d.childNodes.length, 1);
  });
});
