/** 국토교통부 실거래가 API 응답(평면 XML) 전용 파서.
 *  Workers에는 DOMParser가 없다. 응답 구조가 <item><field>값</field>…</item> 로 평면적이라
 *  정규식으로 충분하고, 프로토타입에 없던 오류 응답 감지도 여기서 한다. */

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const unescape = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
                       .replace(/&(amp|lt|gt|quot|apos);/g, m => ENT[m]);

/** 첫 번째 <tag>…</tag> 의 텍스트 */
export function tagText(xml, tag){
  const m = xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
  return m ? unescape(m[1]).trim() : "";
}

/** <item> 블록 각각을 {필드:값} 객체로 */
export function parseItems(xml){
  const out = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let m;
  while((m = re.exec(xml))){
    const o = {};
    const fr = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let f;
    while((f = fr.exec(m[1]))) o[f[1]] = unescape(f[2]).trim();
    out.push(o);
  }
  return out;
}

/**
 * 응답 본문을 검사해 {items, totalCount} 를 돌려주거나, 사람이 읽을 오류를 던진다.
 * 프로토타입은 HTML 오류 페이지를 XML로 파싱해 item 0건 → "거래 없음"으로 잘못 보고했다.
 */
export function parseRtms(body){
  const text = String(body || "");
  if(!/<\s*(response|OpenAPI_ServiceResponse)\b/i.test(text)){
    // XML이 아니다 — 중계 서버 오류 페이지, 빈 응답 등
    const head = text.replace(/\s+/g, " ").slice(0, 80);
    throw new Error("실거래가 API가 XML이 아닌 응답을 보냈습니다: " + (head || "(빈 응답)"));
  }
  // 공공데이터포털 공통 오류 (인증키 오류 등은 OpenAPI_ServiceResponse 로 온다)
  const errMsg = tagText(text, "errMsg") || tagText(text, "returnAuthMsg");
  const reason = tagText(text, "returnReasonCode");
  if(errMsg || reason) throw new Error("공공데이터포털 오류: " + (errMsg || "") + (reason ? " (" + reason + ")" : ""));

  const code = tagText(text, "resultCode");
  if(code && code !== "00" && code !== "000")
    throw new Error("실거래가 API 오류 " + code + " " + tagText(text, "resultMsg"));

  return {
    items: parseItems(text),
    totalCount: Number(tagText(text, "totalCount")) || 0,
    numOfRows: Number(tagText(text, "numOfRows")) || 0,
    pageNo: Number(tagText(text, "pageNo")) || 1
  };
}

const pick = (it, names) => { for(const n of names) if(it[n]) return it[n]; return ""; };

/** 원시 item → 앱이 쓰는 거래 레코드. 유형(아파트/오피스텔/토지…)마다 필드명이 달라 후보를 둔다 */
export function normalizeDeal(it, ym){
  const amt = pick(it, ["dealAmount", "거래금액"]).replace(/,/g, "");
  if(!amt) return null;
  const area = parseFloat(pick(it, ["excluUseAr", "전용면적", "totalFloorAr", "dealArea"])) || 0;
  const y = pick(it, ["dealYear", "년"]), mo = pick(it, ["dealMonth", "월"]), d = pick(it, ["dealDay", "일"]);
  const amount = parseFloat(amt) * 10000;
  return {
    date: y ? y + "-" + String(mo || 1).padStart(2, "0") + "-" + String(d || 1).padStart(2, "0")
            : ym.slice(0, 4) + "-" + ym.slice(4, 6) + "-01",
    name: pick(it, ["aptNm", "offiNm", "mhouseNm", "아파트", "단지", "연립다세대"]),
    dong: pick(it, ["umdNm", "법정동"]),
    area, floor: pick(it, ["floor", "층"]),
    amount,
    unit: area ? amount / 10000 / area : 0     // ㎡당 만원
  };
}
