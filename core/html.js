/** 안전한 DOM 생성 — innerHTML을 쓰지 않는다.
 *
 *  프로토타입은 표를 전부 문자열 조립 + innerHTML로 그렸고, esc()가 작은따옴표를
 *  이스케이프하지 않았다(ANALYSIS.md P2-7 → 다중 사용자 전환으로 P0 승격).
 *  여기서는 텍스트는 항상 textContent로, 속성은 항상 setAttribute로 넣는다.
 *  브라우저가 이스케이프를 대신하므로 사용자 입력이 마크업으로 해석될 경로가 없다. */

/** 문자열 컨텍스트에 꼭 넣어야 할 때만 쓴다. ' 와 / 까지 처리한다. */
export function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"'\/]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "/": "&#x2F;"
  })[c]);
}

const doc = () => {
  if(typeof globalThis.document === "undefined")
    throw new Error("core/html.js는 DOM 환경이 필요합니다");
  return globalThis.document;
};

/** 위험 속성은 처음부터 거부한다 */
const BLOCKED_ATTR = /^on|^srcdoc$|^formaction$/i;
const URL_ATTR = /^(href|src|action|xlink:href)$/i;
const SAFE_URL = /^(https?:|mailto:|tel:|#|\/(?!\/)|\.\/|\.\.\/|blob:|data:image\/(png|jpeg|gif|webp);)/i;

/**
 * 요소 생성. 자식으로 문자열을 주면 텍스트 노드가 된다(마크업으로 해석되지 않는다).
 *   h("td", {class:"r"}, fmt(v))
 *   h("tr", {"data-id": id}, h("td", null, name), h("td", null, memo))
 */
export function h(tag, attrs, ...children){
  const el = doc().createElement(tag);
  if(attrs) for(const k in attrs){
    const v = attrs[k];
    if(v == null || v === false) continue;
    if(BLOCKED_ATTR.test(k)) throw new Error("허용되지 않는 속성: " + k);
    if(k === "class") el.className = String(v);
    else if(k === "style" && typeof v === "object")
      for(const p in v) el.style[p] = v[p];
    else if(k === "dataset" && typeof v === "object")
      for(const p in v) el.dataset[p] = String(v[p]);
    else if(URL_ATTR.test(k) && !SAFE_URL.test(String(v)))
      throw new Error("허용되지 않는 URL: " + k);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(parent, children){
  for(const c of children.flat(Infinity)){
    if(c == null || c === false) continue;
    parent.appendChild(typeof c === "object" && "nodeType" in c
      ? c : doc().createTextNode(String(c)));
  }
  return parent;
}

/** 자식을 전부 비운다 (innerHTML="" 대신) */
export function clear(node){
  while(node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 비우고 새 자식으로 교체 */
export function replace(node, ...children){
  clear(node);
  return append(node, children);
}

/**
 * 표 생성.
 * @param {object} o
 * @param {Array<{key,label,align?:"r"|"c",render?:(row)=>any,cls?:(row)=>string}>} o.columns
 * @param {Array<object>} o.rows
 * @param {(row)=>object} [o.rowAttrs]   각 행의 속성 (data-id 등)
 * @param {Array} [o.foot]              tfoot 셀 배열 (문자열 또는 노드)
 * @param {string} [o.empty]            rows가 비었을 때 문구
 */
export function table({ columns, rows, rowAttrs, foot, empty = "데이터 없음" }){
  const thead = h("thead", null, h("tr", null,
    columns.map(c => h("th", { class: c.align || null }, c.label))));

  const tbody = h("tbody");
  if(!rows.length){
    tbody.appendChild(h("tr", null,
      h("td", { colspan: columns.length, class: "empty" }, empty)));
  }
  for(const r of rows){
    const tr = h("tr", rowAttrs ? rowAttrs(r) : null);
    for(const c of columns){
      const cls = [c.align, c.cls ? c.cls(r) : null].filter(Boolean).join(" ") || null;
      const v = c.render ? c.render(r) : r[c.key];
      tr.appendChild(h("td", { class: cls, ...(c.attrs ? c.attrs(r) : null) }, v));
    }
    tbody.appendChild(tr);
  }

  const t = h("table", null, thead, tbody);
  if(foot && foot.length){
    t.appendChild(h("tfoot", null, h("tr", null,
      foot.map(f => typeof f === "object" && f && "nodeType" in f ? f :
        typeof f === "object" && f ? h("td", f.attrs || null, f.text) : h("td", null, f)))));
  }
  return t;
}
