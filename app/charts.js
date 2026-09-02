/** SVG 차트 — 프로토타입에서 추출. 외부 라이브러리 없음.
 *  변경점: innerHTML·문자열 조립을 전부 제거하고 core/html.js 의 h()/replace()로 바꿨다.
 *  SVG 텍스트는 원래부터 textContent(mk)라 안전했다. */
import { h, replace } from "./core/html.js";
import { fmtWon, fmtNum, isoOf, C, PAL } from "./format.js";
export { emptyChart, lineChart, donutChart, groupedBar, stackedBar, stackedArea, treemap };

const SVGNS = "http://www.w3.org/2000/svg";

function niceTicks(min, max, n){
  n = n || 5;
  if(!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if(min === max){ max = min + (Math.abs(min)||1); }
  const span = max - min, step0 = span/n;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(step0)||1)));
  const norm = step0/mag;
  let step = norm<=1 ? 1 : norm<=2 ? 2 : norm<=2.5 ? 2.5 : norm<=5 ? 5 : 10;
  step *= mag;
  const lo = Math.floor(min/step)*step, hi = Math.ceil(max/step)*step;
  const t = [];
  for(let v=lo; v<=hi+step/2; v+=step) t.push(Math.round(v*1e6)/1e6);
  return {ticks:t, lo, hi};
}
function svgWrap(W, H){
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("viewBox", "0 0 " + W + " " + H);
  s.setAttribute("class", "chart");
  s.setAttribute("preserveAspectRatio", "xMidYMid meet");
  s.style.height = H + "px";
  s.style.maxHeight = "100%";
  return s;
}
function mk(tag, attrs, text){
  const n = document.createElementNS(SVGNS, tag);
  for(const k in attrs) n.setAttribute(k, attrs[k]);
  if(text != null) n.textContent = text;
  return n;
}
function emptyChart(node, msg){
  replace(node, h("div", {class:"empty"}, msg || "데이터 없음"));
}
function axisLabel(v){ return fmtWon(v, false); }

/* ------------------------------------------------------------ 선/영역 차트 */
function lineChart(node, o){
  const series = (o.series||[]).filter(s => s.pts && s.pts.length);
  if(!series.length){ emptyChart(node, o.emptyMsg || "표시할 시세 데이터가 없습니다"); return; }
  const W = 900, H = o.height || 300, m = {l:64, r:70, t:18, b:34};
  const px = W-m.l-m.r, py = H-m.t-m.b;
  let xmin=Infinity, xmax=-Infinity, ymin=Infinity, ymax=-Infinity;
  series.forEach(s => s.pts.forEach(p => {
    const x = +p[0], y = +p[1];
    if(x<xmin)xmin=x; if(x>xmax)xmax=x;
    if(y<ymin)ymin=y; if(y>ymax)ymax=y;
  }));
  (o.hlines||[]).forEach(h => { if(h.y<ymin)ymin=h.y; if(h.y>ymax)ymax=h.y; });
  (o.markers||[]).forEach(k => { if(k.y<ymin)ymin=k.y; if(k.y>ymax)ymax=k.y; });
  if(o.zeroBase) ymin = Math.min(0, ymin);
  else ymin = ymin - (ymax-ymin)*0.08;
  const nt = niceTicks(ymin, ymax, 5);
  if(xmax===xmin) xmax = xmin + 86400000;
  const X = v => m.l + (v-xmin)/(xmax-xmin)*px;
  const Y = v => m.t + (nt.hi-v)/(nt.hi-nt.lo)*py;

  const svg = svgWrap(W, H);
  nt.ticks.forEach(t => {
    svg.appendChild(mk("line",{x1:m.l,x2:m.l+px,y1:Y(t),y2:Y(t),stroke:"#E7ECEF",
      "stroke-dasharray": t===0?"":"3 3", "stroke-width":t===0?1.2:1}));
    svg.appendChild(mk("text",{x:m.l-7,y:Y(t)+3.5,"text-anchor":"end","font-size":10,
      fill:C.gray}, axisLabel(t)));
  });
  const nx = Math.min(7, Math.max(2, Math.floor(px/120)));
  for(let i=0;i<=nx;i++){
    const v = xmin + (xmax-xmin)*i/nx, d = new Date(v);
    const lab = o.dateFmt === "ym" || (xmax-xmin) > 86400000*200
      ? String(d.getFullYear()).slice(2) + "-" + String(d.getMonth()+1).padStart(2,"0")
      : String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    svg.appendChild(mk("text",{x:X(v),y:H-m.b+16,"text-anchor":"middle","font-size":10,
      fill:C.gray}, lab));
  }
  svg.appendChild(mk("line",{x1:m.l,x2:m.l+px,y1:m.t+py,y2:m.t+py,stroke:C.line}));

  (o.hlines||[]).forEach(h => {
    svg.appendChild(mk("line",{x1:m.l,x2:m.l+px,y1:Y(h.y),y2:Y(h.y),
      stroke:h.color||C.grayL,"stroke-dasharray":"5 4","stroke-width":1}));
    if(h.label) svg.appendChild(mk("text",{x:m.l+4,y:Y(h.y)-4,"font-size":10,
      fill:h.color||C.grayL}, h.label));
  });

  series.forEach(s => {
    const pts = s.pts.slice().sort((a,b)=>a[0]-b[0]);
    const d = pts.map((p,i)=> (i?"L":"M") + X(+p[0]).toFixed(1) + " " + Y(+p[1]).toFixed(1)).join(" ");
    if(s.area){
      const base = Y(Math.max(nt.lo, o.zeroBase?0:nt.lo));
      svg.appendChild(mk("path",{d: d + " L"+X(+pts[pts.length-1][0])+" "+base+" L"+X(+pts[0][0])+" "+base+" Z",
        fill:s.color, opacity:s.areaOpacity||0.1, stroke:"none"}));
    }
    svg.appendChild(mk("path",{d, fill:"none", stroke:s.color,
      "stroke-width":s.width||1.8, "stroke-dasharray":s.dash||"",
      "stroke-linejoin":"round","stroke-linecap":"round"}));
    if(s.dots && pts.length<40)
      pts.forEach(p => svg.appendChild(mk("circle",{cx:X(+p[0]),cy:Y(+p[1]),r:3,
        fill:"#fff",stroke:s.color,"stroke-width":1.6})));
    if(s.label !== false){
      const last = pts[pts.length-1];
      svg.appendChild(mk("text",{x:Math.min(X(+last[0])+6, W-4), y:Y(+last[1])-5,
        "font-size":11,"font-weight":700, fill:s.color}, fmtWon(+last[1], false)));
    }
  });

  (o.markers||[]).forEach(k => {
    const x = X(+k.d), y = Y(+k.y), up = k.type !== "매도" && k.type !== "출금";
    const col = up ? C.red : "#1F3F8F";
    const d = up ? "M"+x+" "+(y-7)+" L"+(x-5.5)+" "+(y+3)+" L"+(x+5.5)+" "+(y+3)+" Z"
                 : "M"+x+" "+(y+7)+" L"+(x-5.5)+" "+(y-3)+" L"+(x+5.5)+" "+(y-3)+" Z";
    const p = mk("path",{d, fill:col, opacity:.9});
    p.appendChild(mk("title", {}, (k.type||"") + " " + isoOf(new Date(+k.d)) + " · " +
      fmtNum(k.y) + (k.qty? " · " + fmtNum(k.qty) + "주":"")));
    svg.appendChild(p);
  });

  /* 마우스 커서 안내선 */
  const hover = mk("g", {opacity:0});
  const hl = mk("line",{y1:m.t,y2:m.t+py,stroke:C.navy,"stroke-width":.8,"stroke-dasharray":"3 3"});
  const hb = mk("rect",{x:0,y:2,width:230,height:16*Math.max(1,series.length)+6,rx:4,
    fill:"#fff",stroke:C.line,opacity:.95});
  hover.appendChild(hl); hover.appendChild(hb);
  const texts = series.map(() => mk("text",{"font-size":10.5,fill:C.navy}));
  texts.forEach(t => hover.appendChild(t));
  svg.appendChild(hover);
  const cap = mk("rect",{x:m.l,y:m.t,width:px,height:py,fill:"transparent"});
  svg.appendChild(cap);
  cap.addEventListener("mousemove", ev => {
    const r = svg.getBoundingClientRect();
    const sx = (ev.clientX - r.left) / r.width * W;
    const v = xmin + (sx - m.l)/px*(xmax-xmin);
    hover.setAttribute("opacity", 1);
    hl.setAttribute("x1", sx); hl.setAttribute("x2", sx);
    const bx = Math.min(sx+8, W-236);
    hb.setAttribute("x", bx);
    let head = null;
    series.forEach((s, i) => {
      let best = null, bd = Infinity;
      s.pts.forEach(p => { const dd = Math.abs(+p[0]-v); if(dd<bd){bd=dd; best=p;} });
      if(!best) return;
      if(!head) head = isoOf(new Date(+best[0]));
      texts[i].setAttribute("x", bx+7);
      texts[i].setAttribute("y", 15 + i*15);
      texts[i].setAttribute("fill", s.color);
      texts[i].textContent = (i===0 ? head + "  " : "") + (s.name||"") + " " + fmtWon(+best[1]);
    });
  });
  cap.addEventListener("mouseleave", () => hover.setAttribute("opacity", 0));

  replace(node, svg);
  if(o.legend !== false){
    node.appendChild(h("div", {class:"legend"}, series.map(s =>
      h("span", null, h("i", {style:{background:s.color}}), s.name || ""))));
  }
}

/* ---------------------------------------------------------------- 도넛 차트 */
function donutChart(node, items, centerText){
  items = (items||[]).filter(i => i.value > 0);
  if(!items.length){ emptyChart(node); return; }
  const total = items.reduce((s,i)=>s+i.value,0);
  const W = 900, H = 300, cx = 150, cy = H/2, R = 108, r = 62;
  const svg = svgWrap(W, H);
  let ang = -Math.PI/2;
  items.forEach((it, i) => {
    const a2 = ang + it.value/total*Math.PI*2;
    const big = (a2-ang) > Math.PI ? 1 : 0;
    const p = ["M", cx+R*Math.cos(ang), cy+R*Math.sin(ang),
      "A", R, R, 0, big, 1, cx+R*Math.cos(a2), cy+R*Math.sin(a2),
      "L", cx+r*Math.cos(a2), cy+r*Math.sin(a2),
      "A", r, r, 0, big, 0, cx+r*Math.cos(ang), cy+r*Math.sin(ang), "Z"].join(" ");
    const path = mk("path", {d:p, fill: it.color || PAL[i%PAL.length], stroke:"#fff","stroke-width":1.5});
    path.appendChild(mk("title",{},it.k + " " + fmtWon(it.value) + " (" + (it.value/total*100).toFixed(1) + "%)"));
    svg.appendChild(path);
    const mid = (ang+a2)/2, pctv = it.value/total*100;
    if(pctv >= 4.5)
      svg.appendChild(mk("text",{x:cx+(R+r)/2*Math.cos(mid), y:cy+(R+r)/2*Math.sin(mid)+3.5,
        "text-anchor":"middle","font-size":10.5,"font-weight":700,fill:"#fff"},
        pctv.toFixed(1)+"%"));
    ang = a2;
  });
  if(centerText){
    svg.appendChild(mk("text",{x:cx,y:cy-3,"text-anchor":"middle","font-size":15,
      "font-weight":700,fill:C.navy}, centerText));
    svg.appendChild(mk("text",{x:cx,y:cy+14,"text-anchor":"middle","font-size":10,
      fill:C.gray}, "합계"));
  }
  items.slice(0,12).forEach((it,i) => {
    const y = 30 + i*22, x = 330;
    svg.appendChild(mk("rect",{x, y:y-9, width:11, height:11, rx:2,
      fill: it.color || PAL[i%PAL.length]}));
    svg.appendChild(mk("text",{x:x+18,y,"font-size":11.5,fill:C.navy}, it.k));
    svg.appendChild(mk("text",{x:x+180,y,"font-size":11.5,"text-anchor":"end",
      fill:C.navy}, fmtWon(it.value)));
    svg.appendChild(mk("text",{x:x+240,y:y,"font-size":11.5,"text-anchor":"end",
      fill:C.gray}, (it.value/total*100).toFixed(1)+"%"));
  });
  replace(node, svg);
}

/* ------------------------------------------------------------ 그룹 막대 차트 */
function groupedBar(node, labels, s1, s2, names){
  if(!labels || !labels.length){ emptyChart(node); return; }
  const W = 900, H = 320, m = {l:64, r:16, t:22, b:74};
  const px = W-m.l-m.r, py = H-m.t-m.b;
  const nt = niceTicks(0, Math.max.apply(null, s1.concat(s2)), 5);
  const Y = v => m.t + (nt.hi-v)/(nt.hi-nt.lo)*py;
  const bw = px/labels.length, w = Math.min(26, bw*0.32);
  const svg = svgWrap(W, H);
  nt.ticks.forEach(t => {
    svg.appendChild(mk("line",{x1:m.l,x2:m.l+px,y1:Y(t),y2:Y(t),stroke:"#E7ECEF"}));
    svg.appendChild(mk("text",{x:m.l-7,y:Y(t)+3.5,"text-anchor":"end","font-size":10,
      fill:C.gray}, axisLabel(t)));
  });
  labels.forEach((lb, i) => {
    const cx = m.l + bw*(i+0.5);
    [[s1[i], "#B9D9D2", -1], [s2[i], C.green, 1]].forEach(([v, col, side]) => {
      const h = Math.max(0, Y(0)-Y(v));
      const r = mk("rect",{x:cx + side*2 + (side<0?-w:0), y:Y(v), width:w, height:h,
        fill:col, rx:2});
      r.appendChild(mk("title",{}, lb+" "+fmtWon(v)));
      svg.appendChild(r);
    });
    if(s2[i])
      svg.appendChild(mk("text",{x:cx+2+w/2, y:Y(s2[i])-4,"text-anchor":"middle",
        "font-size":9, fill: s2[i]<s1[i]?C.red:C.navy}, fmtWon(s2[i], false)));
    const t = mk("text",{x:cx, y:H-m.b+15,"text-anchor":"end","font-size":10, fill:C.gray,
      transform:"rotate(-32 "+cx+" "+(H-m.b+15)+")"}, lb);
    svg.appendChild(t);
  });
  svg.appendChild(mk("line",{x1:m.l,x2:m.l+px,y1:Y(0),y2:Y(0),stroke:C.line}));
  replace(node, svg);
  node.appendChild(h("div",{class:"legend"},
    h("span", null, h("i", {style:{background:"#B9D9D2"}}), names[0]),
    h("span", null, h("i", {style:{background:C.green}}), names[1])));
}

/* ------------------------------------------------- 누적 막대 (소유자 × 자산군) */
function stackedBar(node, cats, series){
  if(!cats.length){ emptyChart(node); return; }
  const W = 900, H = 300, m = {l:70, r:16, t:24, b:36};
  const px = W-m.l-m.r, py = H-m.t-m.b;
  let mx = 0, mn = 0;
  cats.forEach((c,i) => {
    let up=0, dn=0;
    series.forEach(s => { const v = s.vals[i]||0; if(v>=0) up+=v; else dn+=v; });
    mx = Math.max(mx, up); mn = Math.min(mn, dn);
  });
  const nt = niceTicks(mn, mx, 5);
  const Y = v => m.t + (nt.hi-v)/(nt.hi-nt.lo)*py;
  const bw = px/cats.length, w = Math.min(70, bw*0.45);
  const svg = svgWrap(W, H);
  nt.ticks.forEach(t => {
    svg.appendChild(mk("line",{x1:m.l,x2:m.l+px,y1:Y(t),y2:Y(t),
      stroke: t===0? C.grayL : "#E7ECEF", "stroke-width": t===0?1.1:1}));
    svg.appendChild(mk("text",{x:m.l-7,y:Y(t)+3.5,"text-anchor":"end","font-size":10,
      fill:C.gray}, axisLabel(t)));
  });
  cats.forEach((c, i) => {
    const cx = m.l + bw*(i+0.5);
    let up = 0, dn = 0;
    series.forEach(s => {
      const v = s.vals[i]||0;
      if(!v) return;
      const y0 = v>=0 ? up : dn, y1 = y0 + v;
      const r = mk("rect",{x:cx-w/2, y:Math.min(Y(y0),Y(y1)), width:w,
        height:Math.abs(Y(y1)-Y(y0)), fill:s.color, stroke:"#fff","stroke-width":.8});
      r.appendChild(mk("title",{}, c+" · "+s.name+" "+fmtWon(Math.abs(v))));
      svg.appendChild(r);
      if(v>=0) up = y1; else dn = y1;
    });
    svg.appendChild(mk("text",{x:cx, y:Y(up)-6,"text-anchor":"middle","font-size":10.5,
      "font-weight":700, fill:C.navy}, "순 " + fmtWon(up+dn)));
    svg.appendChild(mk("text",{x:cx, y:H-m.b+16,"text-anchor":"middle","font-size":11,
      fill:C.navy}, c));
  });
  replace(node, svg);
  node.appendChild(h("div",{class:"legend"}, series.map(s =>
    h("span", null, h("i", {style:{background:s.color}}), s.name))));
}

/* ---------------------------------------------------------------- 누적 영역 */
function stackedArea(node, dates, series){
  series = (series||[]).filter(s => s.vals.some(v=>v>0));
  if(!dates.length || !series.length){ emptyChart(node, "분석을 실행하면 표시됩니다"); return; }
  const W = 900, H = 300, m = {l:64, r:16, t:18, b:34};
  const px = W-m.l-m.r, py = H-m.t-m.b;
  const tops = dates.map((_,i) => series.reduce((s,x)=> s + (x.vals[i]||0), 0));
  const nt = niceTicks(0, Math.max.apply(null, tops), 5);
  const xmin = +dates[0], xmax = +dates[dates.length-1];
  const X = v => m.l + (v-xmin)/((xmax-xmin)||1)*px;
  const Y = v => m.t + (nt.hi-v)/(nt.hi-nt.lo)*py;
  const svg = svgWrap(W, H);
  nt.ticks.forEach(t => {
    svg.appendChild(mk("line",{x1:m.l,x2:m.l+px,y1:Y(t),y2:Y(t),stroke:"#E7ECEF"}));
    svg.appendChild(mk("text",{x:m.l-7,y:Y(t)+3.5,"text-anchor":"end","font-size":10,
      fill:C.gray}, axisLabel(t)));
  });
  const base = new Array(dates.length).fill(0);
  series.forEach((s, si) => {
    const up = [], dn = [];
    dates.forEach((d, i) => {
      const y0 = base[i], y1 = y0 + (s.vals[i]||0);
      up.push([X(+d), Y(y1)]); dn.push([X(+d), Y(y0)]);
      base[i] = y1;
    });
    const d = up.map((p,i)=> (i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ")
      + " " + dn.reverse().map(p=>"L"+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ") + " Z";
    const path = mk("path",{d, fill: s.color || PAL[si%PAL.length], opacity:.92,
      stroke:"#fff","stroke-width":.4});
    path.appendChild(mk("title",{}, s.name + " 최근 " + fmtWon(s.vals[s.vals.length-1])));
    svg.appendChild(path);
  });
  const nx = 6;
  for(let i=0;i<=nx;i++){
    const v = xmin + (xmax-xmin)*i/nx, dd = new Date(v);
    svg.appendChild(mk("text",{x:X(v),y:H-m.b+16,"text-anchor":"middle","font-size":10,
      fill:C.gray}, String(dd.getFullYear()).slice(2)+"-"+String(dd.getMonth()+1).padStart(2,"0")));
  }
  replace(node, svg);
  node.appendChild(h("div",{class:"legend"}, series.map((s,i) =>
    h("span", null, h("i", {style:{background:s.color||PAL[i%PAL.length]}}),
      s.name + " " + fmtWon(s.vals[s.vals.length-1])))));
}

/* ------------------------------------------------------------------ 트리맵 */
function treemap(node, items){
  items = (items||[]).filter(i => i.value > 0).sort((a,b)=> b.value-a.value);
  if(!items.length){ emptyChart(node); return; }
  const W = 900, H = 340;
  const total = items.reduce((s,i)=>s+i.value,0);
  const rects = [];
  let x=0, y=0, w=W, h=H, rest = total;
  items.forEach((it, i) => {
    if(i === items.length-1){ rects.push([x,y,w,h]); return; }
    const frac = it.value/rest;
    if(w >= h){ const cw = w*frac; rects.push([x,y,cw,h]); x+=cw; w-=cw; }
    else{ const ch = h*frac; rects.push([x,y,w,ch]); y+=ch; h-=ch; }
    rest -= it.value;
  });
  const svg = svgWrap(W, H);
  items.forEach((it, i) => {
    const [rx,ry,rw,rh] = rects[i];
    const g = mk("g", {});
    g.appendChild(mk("rect",{x:rx,y:ry,width:Math.max(0,rw-2),height:Math.max(0,rh-2),
      fill: it.color || PAL[i%PAL.length], rx:3}));
    g.appendChild(mk("title",{}, it.k+" "+fmtWon(it.value)+" ("+(it.value/total*100).toFixed(1)+"%)"+
      (it.sub? " · "+it.sub : "")));
    const area = (rw*rh)/(W*H);
    if(area > 0.012){
      const fs = Math.max(10, Math.min(19, 60*Math.pow(area,0.42)));
      g.appendChild(mk("text",{x:rx+rw/2, y:ry+rh/2-(area>0.05?6:0), "text-anchor":"middle",
        "font-size":fs, "font-weight":700, fill:"#fff"}, it.k));
      if(area > 0.045){
        g.appendChild(mk("text",{x:rx+rw/2, y:ry+rh/2+12,"text-anchor":"middle",
          "font-size":Math.max(9, fs*0.62), fill:"#fff", opacity:.95},
          fmtWon(it.value)+"  "+(it.value/total*100).toFixed(1)+"%"));
        if(it.sub) g.appendChild(mk("text",{x:rx+rw/2, y:ry+rh/2+27,"text-anchor":"middle",
          "font-size":Math.max(8.5, fs*0.55), fill:"#EAF6F3"}, it.sub));
      }
    }
    svg.appendChild(g);
  });
  replace(node, svg);
}
