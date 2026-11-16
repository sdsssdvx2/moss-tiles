// Owner-only dashboard (mobile-first). Self-contained HTML/CSS/JS, no external assets.
// Palette (validated with the dataviz validator, light + dark):
//   strategy line  #5B4FD6 / dark #8478EE   (solid)
//   benchmark line #B0782A / dark #B98436   (dashed = secondary encoding)
//   Korean convention for P&L text: 상승 빨강 #C8322F, 하락 파랑 #2563C9 (always with +/- sign)

const CSS = `
:root{--bg:#F6F3EC;--card:#FFFFFF;--ink:#1E1B2E;--ink2:#4A4658;--muted:#7D7889;--line:#E7E1D5;--brand:#5B4FD6;--brand-soft:#ECE9FC;--bench:#B0782A;--up:#C8322F;--down:#2563C9;--ok:#1F8A5B;--warn:#B26A00;--bad:#B4232C;--chip:#F1EDE4;--shadow:0 1px 2px rgba(30,27,46,.06),0 4px 16px rgba(30,27,46,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#141320;--card:#1D1B2B;--ink:#F1EFF8;--ink2:#C9C5D6;--muted:#9590A6;--line:#2E2B40;--brand:#8478EE;--brand-soft:#2A2650;--bench:#B98436;--up:#F0625D;--down:#5B95F0;--ok:#4CC08A;--warn:#E3A33A;--bad:#F06A6A;--chip:#26233A;--shadow:none}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR","Malgun Gothic",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:860px;margin:0 auto;padding:12px 14px 80px}
header{display:flex;align-items:center;gap:10px;padding:6px 0 10px}
.logo{width:34px;height:34px;border-radius:10px;background:var(--brand);display:grid;place-items:center;color:#fff;font-weight:800;font-size:15px;letter-spacing:-.5px}
h1{font-size:18px;margin:0;letter-spacing:-.3px}.sub{font-size:12px;color:var(--muted)}
.paper-badge{margin-left:auto;font-size:11px;font-weight:700;color:var(--brand);background:var(--brand-soft);padding:5px 9px;border-radius:999px;white-space:nowrap}
nav{display:flex;gap:6px;overflow-x:auto;padding:4px 0 10px;position:sticky;top:0;background:var(--bg);z-index:5}
nav button{border:1px solid var(--line);background:var(--card);color:var(--ink2);padding:8px 13px;border-radius:999px;font:inherit;font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer}
nav button.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.card{background:var(--card);border-radius:16px;box-shadow:var(--shadow);border:1px solid var(--line);padding:14px;margin:10px 0}
.hero{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.hero .k{font-size:11px;color:var(--muted)}.hero .v{font-size:20px;font-weight:800;letter-spacing:-.4px}
.notice{font-size:12.5px;color:var(--ink2);background:var(--chip);border-radius:12px;padding:10px 12px;margin:8px 0}
.strat{cursor:pointer}.row{display:flex;align-items:center;gap:8px}.grow{flex:1;min-width:0}
.name{font-weight:700;font-size:15px;line-height:1.3}.meta{font-size:12px;color:var(--muted)}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap}
.b-benchmark{background:var(--chip);color:var(--ink2)}.b-backtest,.b-bt_failed{background:#F3E6D2;color:#7A4B0E}.b-paper{background:var(--brand-soft);color:var(--brand)}
.b-live_candidate{background:#DCF3E8;color:#13603F}.b-halted{background:#FBE0E0;color:var(--bad)}.b-retired{background:var(--chip);color:var(--muted)}
@media (prefers-color-scheme:dark){.b-backtest,.b-bt_failed{background:#3A2E1C;color:#E8B66A}.b-live_candidate{background:#173A2B;color:#6FD7A6}.b-halted{background:#3D1E22;color:#F08A8A}}
.tag{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:1px 6px;white-space:nowrap;display:inline-block;margin:2px 2px 0 0}
.num{font-variant-numeric:tabular-nums}.up{color:var(--up)}.down{color:var(--down)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px}.stats div{background:var(--chip);border-radius:10px;padding:6px 8px}.stats .k{font-size:10.5px;color:var(--muted)}.stats .v{font-size:14px;font-weight:700}
.legend{display:flex;gap:14px;font-size:12px;color:var(--ink2);margin:6px 0 2px}.legend i{display:inline-block;width:18px;height:0;border-top:2px solid var(--brand);vertical-align:middle;margin-right:5px}.legend i.b{border-top:2px dashed var(--bench)}
.chart{position:relative}.chart svg{display:block;width:100%;height:auto;overflow:visible}.tip{position:absolute;pointer-events:none;background:var(--ink);color:var(--bg);font-size:12px;padding:6px 8px;border-radius:8px;white-space:nowrap;transform:translate(-50%,-110%);display:none}
table{width:100%;border-collapse:collapse;font-size:13px}th{font-size:11px;color:var(--muted);font-weight:600;text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}td{padding:7px 4px;border-bottom:1px solid var(--line);vertical-align:top}td.r,th.r{text-align:right}
.reason{font-size:12.5px;color:var(--ink2)}.side{font-weight:800;font-size:12px}.buy{color:var(--up)}.sell{color:var(--down)}
.checks li{list-style:none;margin:3px 0;font-size:13px}.checks{padding:0;margin:6px 0}.ck{display:inline-block;width:18px;font-weight:800}.ck.ok{color:var(--ok)}.ck.no{color:var(--bad)}
.detail{display:none;margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}.open .detail{display:block}
h3{font-size:13px;margin:14px 0 6px;color:var(--ink2);letter-spacing:-.2px}
.bar{height:8px;background:var(--chip);border-radius:99px;overflow:hidden}.bar>span{display:block;height:100%;border-radius:99px;background:var(--brand)}
.pipe{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.lane{background:var(--chip);border-radius:14px;padding:10px;min-height:120px}.lane h4{margin:0 0 8px;font-size:12.5px}.lane .step{font-size:10.5px;color:var(--muted);font-weight:700}
.chip{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px 8px;margin:5px 0;font-size:12px;font-weight:600;line-height:1.3}.chip small{display:block;font-weight:500;color:var(--muted)}
.returnlane{margin-top:8px;border:2px dashed var(--line);border-radius:14px;padding:10px}
.empty{color:var(--muted);font-size:13px;padding:8px 0}
footer{font-size:11.5px;color:var(--muted);margin-top:24px;line-height:1.6}
button.ghost{background:none;border:1px solid var(--line);color:var(--ink2);border-radius:10px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer}
.mbar{display:flex;gap:6px;overflow-x:auto;padding:2px 0 4px;scrollbar-width:none}.mbar::-webkit-scrollbar{display:none}.mbar .m{flex:0 0 auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 10px;min-width:92px}.mbar .m .k{font-size:10.5px;color:var(--muted);white-space:nowrap}.mbar .m .v{font-size:14px;font-weight:800;white-space:nowrap}.mbar .m.hot{border-color:var(--warn)}.mbar .m.hot .v{color:var(--warn)}
.mgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}.mgrid div{background:var(--chip);border-radius:10px;padding:7px 9px}.mgrid .k{font-size:11px;color:var(--muted)}.mgrid .v{font-size:15px;font-weight:700}.mgrid .s{font-size:11px;color:var(--muted)}
.banner{display:none;font-size:13px;background:#FFF1D6;color:#7A4B0E;border:1px solid #F0D29A;border-radius:12px;padding:10px 12px;margin:6px 0}.banner.on{display:block;position:sticky;top:50px;z-index:4;box-shadow:var(--shadow)}.banner button{margin-left:6px}
@media (prefers-color-scheme:dark){.banner{background:#3A2E1C;color:#E8B66A;border-color:#5A4526}}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--brand);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px;margin-left:6px;visibility:hidden}.spin.on{visibility:visible}@keyframes sp{to{transform:rotate(360deg)}}
.skel{height:14px;border-radius:7px;background:linear-gradient(90deg,var(--chip),var(--line),var(--chip));background-size:200% 100%;animation:sk 1.2s ease-in-out infinite;margin:8px 0}@keyframes sk{to{background-position:-200% 0}}
.nf{display:grid;gap:12px;margin-top:6px}.nf .lbl{font-size:12.5px;font-weight:700;color:var(--ink2);margin-bottom:4px}
.nf select{font:inherit;font-size:15px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;min-height:42px}
.trow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.trow .t{display:inline-flex;gap:4px;align-items:center}
.opt{display:flex;gap:4px;background:var(--chip);border-radius:999px;padding:3px}.opt label{flex:1;text-align:center;cursor:pointer;font-size:12.5px;font-weight:650;padding:7px 4px;border-radius:999px;color:var(--ink2);white-space:nowrap}.opt input{position:absolute;opacity:0;width:1px;height:1px}.opt label:has(input:checked){background:var(--card);color:var(--ink);box-shadow:var(--shadow)}.opt label:has(input:focus-visible){outline:2px solid var(--brand)}
.crow{display:grid;gap:4px}.crow .n{font-size:13px;font-weight:650}
.sw{display:flex;gap:8px;align-items:center;font-size:13.5px;font-weight:600}.sw input{width:20px;height:20px}
button.pri{background:var(--brand);color:#fff;border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer;min-height:42px}
@media (max-width:520px){.stats{grid-template-columns:repeat(4,1fr);gap:4px}.stats div{padding:5px 6px}.stats .v{font-size:13px}.stats .k{font-size:9.5px;line-height:1.25}.pipe{grid-template-columns:1fr}.hero .v{font-size:17px}}
`;

const JS = String.raw`
const $=(s,r=document)=>r.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const won=n=>n==null?'-':Math.round(n).toLocaleString('ko-KR')+'원';
const pct=(x,d=1)=>x==null||!isFinite(x)?'-':(x>=0?'+':'')+(x*100).toFixed(d)+'%';
const pabs=(x,d=1)=>x==null?'-':(x*100).toFixed(d)+'%';
const cls=x=>x>0?'up':x<0?'down':'';
const day=t=>{if(!t)return'-';const d=new Date(t*1000);return d.toISOString().slice(0,10)};
const kst=t=>{if(!t)return'-';const d=new Date((t+9*3600)*1000);return d.toISOString().slice(0,16).replace('T',' ')};
const STAGE_ORDER={live_candidate:0,paper:1,halted:2,bt_failed:3,backtest:4,benchmark:5,retired:6};
let DATA=null,TAB='rank';
function chart(curve,{h=170,mini=false}={}){
  if(!curve||curve.length<2)return '<div class="empty">아직 그래프를 그릴 만큼 기록이 없습니다.</div>';
  const W=600,H=h,pl=mini?2:44,pr=8,pt=8,pb=mini?4:22;const base=curve[0].e||1,bb=curve[0].b||1;
  const ys=curve.flatMap(p=>[p.e/base-1,p.b/bb-1]);let lo=Math.min(0,...ys),hi=Math.max(0,...ys);if(hi-lo<0.01){hi+=0.005;lo-=0.005}
  const x=i=>pl+(W-pl-pr)*i/(curve.length-1),y=v=>pt+(H-pt-pb)*(1-(v-lo)/(hi-lo));
  const path=k=>curve.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(k==='e'?p.e/base-1:p.b/bb-1).toFixed(1)).join(' ');
  let g='';if(!mini){for(const v of [hi,(hi+lo)/2,lo]){g+='<line x1="'+pl+'" x2="'+(W-pr)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--line)" stroke-width="1"/><text x="'+(pl-6)+'" y="'+(y(v)+4)+'" font-size="11" text-anchor="end" fill="var(--muted)">'+pct(v,0)+'</text>'}
   g+='<line x1="'+pl+'" x2="'+(W-pr)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3"/>';
   g+='<text x="'+pl+'" y="'+(H-4)+'" font-size="11" fill="var(--muted)">'+day(curve[0].t)+'</text><text x="'+(W-pr)+'" y="'+(H-4)+'" font-size="11" text-anchor="end" fill="var(--muted)">'+day(curve[curve.length-1].t)+'</text>'}
  const id='c'+Math.random().toString(36).slice(2);
  return '<div class="chart" data-id="'+id+'"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="이 전략과 기준선의 수익률 추이">'+g+'<path d="'+path('b')+'" fill="none" stroke="var(--bench)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/><path d="'+path('e')+'" fill="none" stroke="var(--brand)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>'+(mini?'':'<line class="xh" y1="'+pt+'" y2="'+(H-pb)+'" stroke="var(--ink2)" stroke-width="1" style="display:none"/><rect x="'+pl+'" y="0" width="'+(W-pl-pr)+'" height="'+H+'" fill="transparent" class="hit"/>')+'</svg><div class="tip"></div></div>';
}
function wireCharts(root,curves){root.querySelectorAll('.chart').forEach((el,i)=>{const c=curves[el.dataset.id];const hit=el.querySelector('.hit');if(!hit||!c)return;const svg=el.querySelector('svg'),tip=el.querySelector('.tip'),xh=el.querySelector('.xh');
 const mv=ev=>{const r=svg.getBoundingClientRect();const W=600,pl=44,pr=8;const px=(ev.clientX-r.left)/r.width*W;const i=Math.max(0,Math.min(c.length-1,Math.round((px-pl)/(W-pl-pr)*(c.length-1))));const p=c[i];const xx=pl+(W-pl-pr)*i/(c.length-1);
  xh.setAttribute('x1',xx);xh.setAttribute('x2',xx);xh.style.display='';tip.style.display='block';tip.style.left=(xx/W*100)+'%';tip.style.top='18px';
  tip.innerHTML=day(p.t)+'<br>이 전략 '+pct(p.e/c[0].e-1)+' · 기준 '+pct(p.b/c[0].b-1)};
 hit.addEventListener('pointermove',mv);hit.addEventListener('pointerleave',()=>{tip.style.display='none';xh.style.display='none'})})}
const CURVES={};
function chartReg(curve,o){const s=chart(curve,o);const m=s.match(/data-id="(c[a-z0-9]+)"/);if(m)CURVES[m[1]]=curve;return s}
function badge(s){return '<span class="badge b-'+s.stage+'">'+esc(s.label)+'</span>'}
function stratCard(s){
  const p=s.paper;const ret=p?p.ret:null,br=p?p.benchRet:null;
  const tags=[s.market==='krx'?'국내':'코인',s.timeframe==='1h'?'1시간봉':'일봉',s.cadence==='slow'?'느린 전략':'잦은 매매'];if(s.researchOnly)tags.push('연구용');if(s.simulationOnly)tags.push('모의 전용(선물 시뮬레이션)');if(s.sleeve==='aggressive')tags.push('고위험');if(s.generated)tags.push('자동 연구 변형');if(s.overlayOf)tags.push(s.id.includes('_ai_')?'AI 비교 장부':'뉴스 거부권 비교 장부');
  let h='<div class="card strat" data-id="'+esc(s.id)+'"><div class="row"><div class="grow"><div class="name">'+esc(s.name)+'</div><div class="meta">'+tags.map(t=>'<span class="tag">'+esc(t)+'</span>').join(' ')+'</div></div>'+badge(s)+'</div>';
  h+='<div class="stats"><div><div class="k">모의 수익</div><div class="v num '+cls(ret)+'">'+pct(ret)+'</div></div><div><div class="k">기준(그냥 보유)</div><div class="v num '+cls(br)+'">'+pct(br)+'</div></div><div><div class="k">고점 대비 지금</div><div class="v num">'+(p?(p.dd>0.0005?'-'+pabs(p.dd):'0%'):'-')+'</div></div><div><div class="k">체결</div><div class="v num">'+(p?p.fills+'회':'-')+'</div></div></div>';
  h+='<div style="margin-top:8px">'+chartReg(s.curve,{h:56,mini:true})+'</div>';
  h+='<div class="detail">'+detail(s)+'</div></div>';return h}
function detail(s){
  const p=s.paper;let h='<p class="reason">'+esc(s.description)+'</p><div class="notice">'+esc(s.summary)+'</div>';
  h+='<div class="legend"><span><i></i>이 전략</span><span><i class="b"></i>기준(그냥 사서 보유)</span></div>'+chartReg(s.curve,{h:190});
  if(p){h+='<h3>지금 가상 계좌</h3><table><tr><td>평가금액</td><td class="r num">'+won(p.equity)+'</td></tr><tr><td>현금</td><td class="r num">'+won(p.cash)+'</td></tr><tr><td>낸 수수료·세금</td><td class="r num">'+won(p.fees)+'</td></tr><tr><td>모의 시작</td><td class="r">'+day(p.startT)+'</td></tr></table>'}
  h+='<h3>들고 있는 것</h3>';
  h+=s.positions.length?'<table><tr><th>종목</th><th class="r">비중</th><th class="r">평가</th><th class="r">손익</th></tr>'+s.positions.map(x=>'<tr><td>'+esc(x.name)+'</td><td class="r num">'+pabs(x.weight,0)+'</td><td class="r num">'+won(x.value)+'</td><td class="r num '+cls(x.pnlPct)+'">'+pct(x.pnlPct)+'</td></tr>').join('')+'</table>':'<div class="empty">지금은 전부 현금입니다.</div>';
  if(s.pending.length)h+='<h3>다음 시가에 낼 가상 주문</h3>'+s.pending.map(o=>'<div class="reason"><span class="side '+(o.side==='BUY'?'buy':'sell')+'">'+(o.side==='BUY'?'매수':'매도')+'</span> '+esc(o.reason)+'</div>').join('');
  h+='<h3>최근 거래와 이유</h3>'+(s.recent.length?'<table>'+s.recent.map(f=>'<tr><td style="width:84px"><div class="meta">'+day(f.t)+'</div><span class="side '+(f.side==='BUY'?'buy':'sell')+'">'+(f.side==='BUY'?'매수':'매도')+'</span></td><td><b>'+esc(f.name)+'</b> <span class="meta num">'+won(f.price)+'</span><div class="reason">'+esc(f.reason)+'</div>'+(f.side==='SELL'?'<div class="meta num '+cls(f.pnl)+'">손익 '+won(f.pnl)+'</div>':'')+'</td></tr>').join('')+'</table>':'<div class="empty">아직 거래가 없습니다.</div>');
  const r=s.risk;h+='<h3>위험 관리 상태</h3>';
  if(p){const lim=r.maxDrawdownHalt||0;h+=lim?'<div class="meta">고점 대비 손실 '+pabs(p.dd)+' / 멈춤 기준 '+pabs(lim,0)+'</div><div class="bar"><span style="width:'+Math.min(100,p.dd/lim*100)+'%;background:'+(p.dd/lim>.7?'var(--bad)':'var(--brand)')+'"></span></div>':'<div class="meta">기준선은 멈추지 않습니다.</div>';if(p.halted)h+='<div class="notice">⛔ '+esc(p.haltReason)+'</div>'}
  h+='<div class="meta">한 종목 최대 '+pabs(r.maxPositionWeight,0)+' · 현금 최소 '+pabs(r.minCash,0)+' · 하루 손실 '+(r.dailyLossLimit?pabs(r.dailyLossLimit,0)+'이면 매수 중지':'제한 없음')+' · 주간 '+(r.weeklyLossLimit?pabs(r.weeklyLossLimit,0):'제한 없음')+'</div>';
  if(s.checks.length)h+='<h3>승격 체크리스트</h3><ul class="checks">'+s.checks.map(c=>'<li><span class="ck '+(c.ok?'ok':'no')+'">'+(c.ok?'✓':'✗')+'</span>['+esc(c.group)+'] '+esc(c.text)+'</li>').join('')+'</ul>';
  if(s.bt){const b=s.bt,ho=b.holdout||{};h+='<h3>과거 검증(백테스트)</h3><table><tr><td>기간</td><td class="r">'+(b.range?esc(b.range):'-')+' ('+(b.years?b.years.toFixed(1):'-')+'년)</td></tr><tr><td>끝까지 안 본 구간 수익</td><td class="r num '+cls(ho.totalReturn)+'">'+pct(ho.totalReturn)+' (기준 '+pct(ho.bench?.totalReturn)+')</td></tr><tr><td>비용 2배일 때</td><td class="r num">'+pct(b.holdout2x?.totalReturn)+'</td></tr><tr><td>최대 낙폭</td><td class="r num">'+pabs(ho.mdd)+' (기준 '+pabs(ho.bench?.mdd)+')</td></tr><tr><td>샤프(위험 대비 수익)</td><td class="r num">'+(ho.sharpe??0).toFixed(2)+'</td></tr><tr><td>전체 거래 수</td><td class="r num">'+(b.totalTrades??'-')+'</td></tr><tr><td>시도 횟수 보정 실력 확률</td><td class="r num">'+(b.dsr!=null?Math.round(b.dsr*100)+'%':'-')+' (시도 '+(b.trials||s.trials)+'번)</td></tr><tr><td>출처</td><td class="r">'+(b.source==='worker'?'워커 자체 재검증':'PC 정밀 검증')+'</td></tr></table>';if(b.curve)h+='<div class="legend"><span><i></i>백테스트</span><span><i class="b"></i>기준</span></div>'+chartReg(b.curve.map(p=>({t:p.t,e:p.e,b:p.b})),{h:150})}
  return h}
function hero(){const S=DATA.strategies.filter(s=>s.paper);const cand=DATA.strategies.filter(s=>s.stage==='live_candidate').length;const halted=DATA.strategies.filter(s=>s.stage==='halted').length;
  const best=S.filter(s=>!s.benchmarkOnly&&!s.sleeve).sort((a,b)=>b.paper.ret-a.paper.ret)[0];
  return '<div class="card"><div class="hero"><div><div class="k">실거래 가능(소액) 후보</div><div class="v num">'+cand+'개</div></div><div><div class="k">가장 잘하는 전략</div><div class="v num '+cls(best?.paper.ret)+'">'+(best?pct(best.paper.ret):'-')+'</div><div class="meta">'+esc(best?.name||'')+'</div></div><div><div class="k">멈춘 전략</div><div class="v num">'+halted+'개</div></div></div></div>'}
function viewRank(){const sorted=[...DATA.strategies].sort((a,b)=>(STAGE_ORDER[a.stage]-STAGE_ORDER[b.stage])||((b.paper?.ret??-9)-(a.paper?.ret??-9)));
  const main=sorted.filter(s=>s.sleeve!=='aggressive'),agg=sorted.filter(s=>s.sleeve==='aggressive');
  const sl=DATA.sleeve||{};const sleeveHead='<div class="card" style="border:2px solid var(--bad)"><div class="row"><div class="grow"><div class="name">⚠️ 고위험(잃어도 되는 돈만) · 공격형 슬롯</div><div class="meta">슬롯 전체가 '+pabs(sl.maxTotalLoss??0.3,0)+' 잃으면 모두 멈추고 자동으로 다시 채우지 않습니다. 나중 실거래 한도 '+won(sl.budgetKrw)+'.</div></div><div class="num '+cls(sl.ret)+'" style="font-weight:800">'+pct(sl.ret)+'</div></div>'+(sl.stopped?'<div class="notice">⛔ '+esc(sl.stopped)+'</div>':'')+'</div>';
  return marketBar()+hero()+'<div class="notice">모든 숫자는 <b>가상 돈 1,000만 원</b>(전략마다 따로)으로 한 모의투자입니다. 실제 주문은 하지 않습니다. 카드를 누르면 자세한 내용(이유·보유·위험)이 보입니다.</div>'+main.map(stratCard).join('')+(agg.length?sleeveHead+agg.map(stratCard).join(''):'')}
function viewLife(){const col=(stages)=>DATA.strategies.filter(s=>stages.includes(s.stage));const chip=s=>'<span class="chip">'+esc(s.name)+'<small>'+esc(s.label)+(s.paper?' · '+pct(s.paper.ret):'')+'</small></span>';
  let h='<div class="card"><h3 style="margin-top:0">전략 수명주기</h3><div class="pipe"><div class="lane"><div class="step">1단계</div><h4>백테스트</h4>'+col(['backtest','bt_failed']).map(chip).join('')+'</div><div class="lane"><div class="step">2단계</div><h4>모의 검증</h4>'+col(['paper']).map(chip).join('')+'</div><div class="lane"><div class="step">3단계</div><h4>소액 실거래 후보</h4>'+(col(['live_candidate']).map(chip).join('')||'<div class="empty">아직 없음</div>')+'</div></div>';
  h+='<div class="returnlane"><h4 style="margin:0 0 6px;font-size:12.5px">⛔ 중단 → 모의 복귀</h4>'+(col(['halted']).map(chip).join('')||'<div class="empty">없음</div>')+'</div>';
  const others=col(['benchmark','retired']);if(others.length)h+='<h3>비교 기준 · 대체된 버전</h3>'+others.map(chip).join('');
  h+='</div><div class="card"><h3 style="margin-top:0">각 단계의 뜻</h3><p class="reason"><b>백테스트</b>: 몇 년치 과거 데이터로, 마지막 25%는 끝까지 안 보고 남겨 둔 뒤 한 번만 시험합니다. 수수료 2배에서도 벌어야 하고, 여러 번 시도한 만큼 더 강한 증거를 요구합니다.</p><p class="reason"><b>모의 검증</b>: 가상 돈으로 실제 시장에서 2주~1개월 돌려 "백테스트와 똑같이 움직이는지"(체결 일치, 오류 없음)를 확인합니다. 이 짧은 기간은 실력 증명이 아닙니다.</p><p class="reason"><b>실거래 가능(소액)</b>: 알림과 배지만 나옵니다. 이 프로그램에는 실제 주문 기능이 <b>없습니다</b>. 나중에 사람이 검토해 전략당 2~3만 원부터 시작하는 단계입니다.</p><p class="reason"><b>중단 → 모의 복귀</b>: 손실 한도·연속 손실 같은 자동 중단 규칙에 걸리면 후보에서 내려와 모의 검증을 처음부터 다시 합니다. 개선판은 새 이름(예: _v2)으로 1단계부터 다시 시작합니다.</p></div>';return h}
function viewAlloc(){const A=DATA.allocation;const name=id=>DATA.strategies.find(s=>s.id===id)?.name||id;
  if(!A.length)return '<div class="card"><h3 style="margin-top:0">전략 운용 매니저</h3><div class="empty">첫 배분은 일주일에 한 번 계산됩니다. 아직 기록이 없습니다.</div><p class="reason">몇 번 졌다고 전략을 바꾸지 않고, <b>최근 90일(최소 60일)</b>의 위험 대비 성과로 예산을 나눕니다. 파이프라인을 통과한 전략만 받을 수 있고, 한 전략 최대 40%, 기준선(적립식)에 최소 20%, 한 번에 ±10%p까지만 일주일에 한 번 바꿉니다.</p></div>';
  const cur=A[0];let h='<div class="card"><h3 style="margin-top:0">전략 운용 매니저 · '+day(cur.t)+'</h3>'+Object.entries(cur.weights).sort((a,b)=>b[1]-a[1]).map(([id,w])=>'<div style="margin:8px 0"><div class="row"><div class="grow" style="font-size:13px;font-weight:600">'+esc(name(id))+'</div><div class="num" style="font-weight:700">'+pabs(w,0)+'</div></div><div class="bar"><span style="width:'+(w*100)+'%"></span></div><div class="meta">'+esc(cur.notes[id]||'')+'</div></div>').join('')+'</div>';
  h+='<div class="card"><h3 style="margin-top:0">배분 기록</h3><table><tr><th>날짜</th><th>배분</th></tr>'+A.map(a=>'<tr><td class="num">'+day(a.t)+'</td><td class="reason">'+Object.entries(a.weights).map(([id,w])=>esc(name(id))+' '+pabs(w,0)).join(' · ')+'</td></tr>').join('')+'</table></div>';return h}

const FG_KO={'Extreme Fear':'극단적 공포','Fear':'공포','Neutral':'중립','Greed':'탐욕','Extreme Greed':'극단적 탐욕'};
const LV_KO={close:'청산 전용',block:'새로 안 삼',half:'새 매수 절반'};
const usd=x=>x==null?'-':'$'+(x>=1e9?(x/1e9).toFixed(2)+'B':x>=1e6?(x/1e6).toFixed(1)+'M':Math.round(x).toLocaleString('en-US'));
const pp=(x,d=2)=>x==null||!isFinite(x)?'-':(x>=0?'+':'')+(x*100).toFixed(d)+'%';
const krw=x=>x?Math.round(x).toLocaleString('ko-KR')+'원':'-';
function mkHealth(g,now){if(!g.at)return '<span class="ck no">✗</span>';const okLast=(g.at||0)>=(g.tried||0);const fresh=now-g.at<3*g.everyMin*60;if(okLast&&fresh&&!g.errors.length)return '<span class="ck ok">✓</span>';if(okLast&&fresh)return '<span class="ck" style="color:var(--warn)">△</span>';return '<span class="ck no">✗</span>'}
function mkItems(M){const p=M.premium||{},d=M.derivs||{},c=M.config,fg=M.fearGreed,liq=d.liq,hl=d.hl||{};
  return [
   ['김프(USDT 기준)',pp(p.premUsdt),p.premUsdt!=null&&p.premUsdt>c.premHalf,'3% 넘으면 절반, 5% 넘으면 보류'],
   ['테더 김프',pp(p.tether),p.tether!=null&&p.tether>c.tetherMax,'업비트 USDT '+krw(p.upbitUsdt)],
   ['BTC 김프',pp(p.kimchi),false,'환율 '+krw(p.fx)+' 기준(참고)'],
   ['코인베이스 프리미엄',pp(p.coinbase,3),p.coinbase!=null&&p.coinbase<c.coinbaseMin,'미국 매수세(+)/매도세(-)'],
   ['빗썸 USDT',krw(p.bithumbUsdt),false,'테더 김프 '+pp(p.tetherBithumb)],
   ['거래소 가격 차이',p.foreignDev==null?'-':pp(p.foreignDev),(p.foreignDev>c.priceDevMax)||(p.krDev>c.priceDevMax),'해외 '+(p.foreignN||0)+'곳 · 업비트↔빗썸 '+pp(p.krDev)],
   ['미결제약정',usd(d.oi&&d.oi.totalUsd),false,'24시간 '+pp(d.oi&&d.oi.chg24h,1)+' · OKX BTC+ETH (기록만)'],
   ['펀딩비 BTC',d.funding&&d.funding.BTC!=null?pp(d.funding.BTC,3):'-',false,'8시간 · OKX / Hyperliquid '+(hl.BTC&&hl.BTC.funding8h!=null?pp(hl.BTC.funding8h,3):'-')+' (기록만)'],
   ['롱숏 비율',d.ls&&d.ls.BTC!=null?d.ls.BTC.toFixed(2):'-',false,'BTC 계정 기준(1 넘으면 롱 많음)'],
   ['강제청산 롱 비중',liq&&liq.longShare!=null?Math.round(liq.longShare*100)+'%':'-',false,liq?usd(liq.usd)+' · 최근 '+(liq.hours<1?Math.round(liq.hours*60)+'분':liq.hours.toFixed(1)+'시간')+' 표본(OKX, 기록만)':'-'],
   ['공포·탐욕',fg?fg.value+'':'-',false,fg?(FG_KO[fg.label]||fg.label)+' (참고만, 매매에 안 씀)':'-'],
  ]}
function mkState(g){if(!g)return ['확인 중',''];if(g.damp&&g.damp.factor===0)return ['새 매수 보류','hot'];if(g.damp)return ['새 매수 ×'+g.damp.factor,'hot'];if(g.altHold)return ['알트 보류','hot'];return ['평소','']}
function marketBar(){const M=DATA.marketSignals;if(!M||!M.enabled)return '';const st=mkState(M.guard);const show=['김프(USDT 기준)','테더 김프','코인베이스 프리미엄','미결제약정','강제청산 롱 비중','공포·탐욕'];
  return '<div class="mbar" id="mbar" title="누르면 자세히"><div class="m '+st[1]+'"><div class="k">코인 시장 신호</div><div class="v"'+(st[1]?'':' style="color:var(--ok)"')+'>'+esc(st[0])+'</div></div>'+mkItems(M).filter(x=>show.includes(x[0])).map(x=>'<div class="m'+(x[2]?' hot':'')+'"><div class="k">'+esc(x[0])+'</div><div class="v num">'+esc(x[1])+'</div></div>').join('')+'</div>'}
function marketCard(){const M=DATA.marketSignals;if(!M)return '';if(!M.enabled)return '<div class="card"><h3 style="margin-top:0">코인 시장 신호</h3><div class="empty">꺼져 있음 (MARKET_SIGNALS_ENABLED=false)</div></div>';
  const g=M.guard||{coins:{},damp:null,altHold:null,warnings:[]},c=M.config;const coins=Object.entries(g.coins||{});
  let h='<div class="card"><h3 style="margin-top:0">코인 시장 신호 <span class="meta">(사고를 피하는 문지기 · 이것으로 사지 않음)</span></h3>';
  h+='<div class="notice">'+(g.damp?'🌡️ <b>'+esc(g.damp.reason)+'</b> → 코인 전략의 새 매수를 <b>'+(g.damp.factor===0?'보류':'×'+g.damp.factor)+'</b>합니다.':'✓ 시장 전체: 김프·가격 차이 이상 없음 → 새 매수량 그대로.')+'<br>'+(g.altHold?'⚠️ <b>'+esc(g.altHold)+'</b> → 알트코인 새 매수 보류 (비트·이더는 그대로).<br>':'')+(coins.length?'🛡️ 우리 코인 중 <b>'+coins.length+'개</b>에 제한이 걸려 있습니다. 자동으로 팔지는 않고, 공격형 슬롯만 다음 판단 때 정리합니다.':'🛡️ 우리 전략이 다루는 코인에는 경보·공지 제한이 없습니다.')+'</div>';
  if(coins.length)h+='<table>'+coins.map(([s,x])=>'<tr><td><b>'+esc(s.replace('KRW-',''))+'</b><div class="meta">'+esc(LV_KO[x.level]||x.level)+'</div></td><td class="reason">'+esc(x.why)+'</td></tr>').join('')+'</table>';
  if(g.frozen&&g.frozen.length)h+='<div class="notice">🧊 업비트 목록에서 사라진 코인: '+esc(g.frozen.join(', '))+' — 자동 청산하지 않습니다. 직접 확인하세요.</div>';
  h+='<div class="mgrid" style="margin-top:8px">'+mkItems(M).map(x=>'<div'+(x[2]?' style="outline:2px solid var(--warn)"':'')+'><div class="k">'+esc(x[0])+(x[2]?' ⚠️':'')+'</div><div class="v num">'+esc(x[1])+'</div><div class="s">'+esc(x[3])+'</div></div>').join('')+'</div>';
  h+='<h3>규칙 (임시 기준, 설정으로 조정)</h3><div class="meta">· 업비트 투자유의·거래지원 종료·유의 촉구 → 청산 전용(새로 안 삼)<br>· 업비트 주의(거래량 급증·소수 계정 집중), 빗썸 경고·위험, 입출금 중단('+c.suspendHours+'시간), 신규 상장('+c.listingDays+'일), 바이낸스 상장폐지 공지 → 새로 안 삼<br>· 업비트 주의(입금량 급증·해외 가격 차이) → 새 매수 절반 (비트·이더는 경고만)<br>· 김프(USDT 기준) '+pp(c.premHalf,0)+' 초과 절반, '+pp(c.premHold,0)+' 초과 보류 · 거래소 가격 차이 '+pp(c.priceDevMax,0)+' 초과 보류 · 테더 김프 '+pp(c.tetherMax,0)+' 초과 절반 · 코인베이스 프리미엄 '+pp(c.coinbaseMin,1)+' 미만 절반<br>· 펀딩비·미결제약정·청산·롱숏은 '+(c.derivRules?'<b>규칙 켜짐</b>':'처음 90일 <b>기록만</b>')+' · 공포·탐욕은 참고만</div>';
  if(g.warnings&&g.warnings.length)h+='<h3>참고 경고 (효과 없음)</h3><div class="meta">'+g.warnings.map(esc).join('<br>')+'</div>';
  h+='<h3>업비트 공지 (공식 텔레그램)'+(M.noticesOk?'':' ⚠️ 데이터 없음')+'</h3>'+(M.notices.length?M.notices.map(n=>'<div class="reason">'+kst(n.t)+' <span class="tag">'+esc({close:'청산 전용',suspend:'입출금 중단',listing:'신규 상장'}[n.rule]||n.rule)+'</span> '+esc(n.title)+'</div>').join(''):'<div class="empty">최근 관련 공지 없음</div>');
  h+='<h3>업비트 유의·주의 종목 ('+M.flagCount+'개)</h3>'+(M.flags.length?'<div class="meta">'+M.flags.map(f=>(f.relevant?'<b>':'')+esc(f.sym.replace('KRW-',''))+(f.warning?' 투자유의':'')+(f.caution.length?' 주의':'')+(f.missing?' 정보없음':'')+(f.relevant?'</b>':'')).join(' · ')+'</div><div class="meta">굵은 글씨 = 우리 전략이 다루는 코인</div>':'<div class="empty">없음</div>');
  h+='<h3>빗썸 경고·위험 / 입출금 중단</h3><div class="meta">'+(M.bithumbWarnings.length?M.bithumbWarnings.map(w=>esc(w.sym.replace('KRW-',''))+' '+esc(w.step)).join(' · '):'경고·위험 없음')+'<br>입출금 중단 '+M.walletCount+'개 중 우리 코인 '+M.wallet.length+'개'+(M.wallet.length?': '+M.wallet.map(w=>esc(w.sym.replace('KRW-',''))).join(', '):'')+'</div>';
  h+='<h3>최근 상장폐지 공지 (바이낸스 현물)</h3>'+(M.delist.length?M.delist.map(d=>'<div class="reason">'+day(d.t)+' '+esc(d.coins.join(', '))+'</div>').join(''):'<div class="empty">최근 2주 없음</div>');
  h+='<h3>출처 상태</h3><table><tr><th></th><th>신호</th><th>주기</th><th>마지막 성공</th></tr>'+M.groups.map(x=>'<tr><td>'+mkHealth(x,DATA.now)+'</td><td>'+esc(x.name)+(x.errors.length?'<div class="meta">일부 실패: '+esc(x.errors.join(', '))+'</div>':'')+'</td><td class="meta">'+(x.everyMin>=60?x.everyMin/60+'시간':x.everyMin+'분')+'</td><td class="meta">'+kst(x.at)+'</td></tr>').join('')+'</table>';
  h+='<div class="meta" style="margin-top:6px">✓ 정상 · △ 일부 출처 실패 · ✗ 실패 또는 오래됨. 업비트 공지 게시판과 CNN 공포탐욕은 자동 접속을 막아 쓰지 않습니다(업비트 공지는 공식 텔레그램으로 대신). 입출금 상태는 업비트가 공개하지 않아 빗썸 공개 정보로 대신합니다. 출처 접속 시험: <a href="/probe">/probe</a></div></div>';return h}
function viewData(){const d=DATA.data;const st=h=>{const ok=(h.last_ok||0)>=(h.last_err||0);return '<span class="ck '+(ok?'ok':'no')+'">'+(ok?'✓':'✗')+'</span>'};
  let h='<div class="card" id="ncard">'+(NS?notifyCard(NS):'<h3 style="margin-top:0">알림 설정 (텔레그램)</h3><div class="skel"></div><div class="skel" style="width:60%"></div>')+'</div>'+marketCard()+'<div class="card"><h3 style="margin-top:0">시세 수집 상태</h3><table><tr><th>구분</th><th>마지막 완성 봉</th><th class="r">범위</th></tr><tr><td>국내 일봉</td><td>'+day(d.ready.krx)+'</td><td class="r meta">'+d.coverage.krx.symbols+'종목 · '+day(d.coverage.krx.from)+'~</td></tr><tr><td>코인 일봉</td><td>'+day(d.ready.crypto1d)+'</td><td class="r meta">'+d.coverage.crypto1d.symbols+'종목 · '+day(d.coverage.crypto1d.from)+'~</td></tr><tr><td>코인 1시간봉</td><td>'+kst(d.ready.crypto1h)+'</td><td class="r meta">'+d.coverage.crypto1h.symbols+'종목</td></tr></table>';
  h+='<h3>출처별 상태</h3><table><tr><th></th><th>출처</th><th>마지막 성공</th><th>마지막 오류</th></tr>'+d.health.map(x=>'<tr><td>'+st(x)+'</td><td>'+esc(x.source)+'</td><td class="meta">'+kst(x.last_ok)+'</td><td class="meta">'+(x.last_err?kst(x.last_err)+'<br>'+esc(x.err||''):'-')+'</td></tr>').join('')+'</table>';
  h+='<h3>연결된 데이터</h3><ul class="checks"><li><span class="ck '+(d.sources.krxKey?'ok':'no')+'">'+(d.sources.krxKey?'✓':'–')+'</span>KRX 공식 API 키</li><li><span class="ck '+(d.sources.dataGoKr?'ok':'no')+'">'+(d.sources.dataGoKr?'✓':'–')+'</span>공공데이터포털 키</li><li><span class="ck '+(d.sources.naver?'ok':'no')+'">'+(d.sources.naver?'✓':'–')+'</span>네이버 공개 차트(비공식, 예비용)</li><li><span class="ck ok">✓</span>업비트 공개 시세(키 없음)</li><li><span class="ck '+(d.sources.telegram?'ok':'no')+'">'+(d.sources.telegram?'✓':'–')+'</span>텔레그램 알림 '+(d.sources.telegram?'<button class="ghost" id="tg">테스트 보내기</button>':'(텔레그램-연결.cmd 로 설정)')+'</li><li><span class="ck ok">✓</span>뉴스 거부권: '+esc(d.sources.newsVeto==='none'?'꺼짐(항상 "거부 없음")':d.sources.newsVeto==='ai'?(d.sources.ai?'AI가 판단(비교 장부에서만 적용)':'AI 연결 대기 중'):d.sources.newsVeto)+'</li></ul>';
  h+='<h3>뉴스·지표 피드</h3><table><tr><th></th><th>피드</th><th class="r">최근 3일</th></tr>'+d.feeds.map(f=>{const c=d.feedCounts.find(x=>x.source===f.id);const hh=d.health.find(x=>x.source==='feed:'+f.id);const ok=f.enabled&&hh&&(hh.last_ok||0)>=(hh.last_err||0);return '<tr><td><span class="ck '+(ok?'ok':'no')+'">'+(f.enabled?(ok?'✓':'✗'):'–')+'</span></td><td>'+esc(f.name)+(f.enabled?'':' <span class="meta">('+esc(f.needs)+' 키 필요)</span>')+(hh&&hh.err&&!ok?'<div class="meta">'+esc(hh.err)+'</div>':'')+'</td><td class="r num">'+(c?c.n+'건':'-')+'</td></tr>'}).join('')+'</table>';
  h+='<div class="notice">AI 판단: '+(d.sources.ai?'켜짐 ('+esc(d.sources.ai)+') — 하루 4번(6시간마다) 뉴스·지표를 읽고 점수를 매기며, AI 비교 장부에서만 새로 사는 양을 0.5~1배로 조절합니다.':'<b>꺼짐</b> — AI 연결(Workers AI)이 아직 배포되지 않아 "AI 판단" 장부는 규칙 전략과 똑같이 움직입니다(효과 없음).')+(d.aiAudit.length?'<br>최근 호출: '+d.aiAudit.map(a=>kst(a.t)+(a.ok?' 성공':' 실패('+esc(a.note||'')+')')).join(', '):'')+'</div>';h+=(d.research?'<div class="notice">주간 자동 연구: '+(!d.research.url?'<b>꺼짐</b> (RESEARCH_URL 미설정)':d.research.last?'마지막 반영 '+kst(d.research.last.at)+' — 백테스트 '+d.research.last.backtests+'개, 새 변형 '+d.research.last.variants+'개':'켜짐 — 첫 결과 기다리는 중 (매주 일요일 새벽 실행)')+(d.research.error?' · 최근 확인 오류: '+esc(d.research.error):'')+'</div>':'');
  if(d.universe.length)h+='<div class="meta">코인 수집 대상: '+d.universe.map(u=>esc(u.name)).join(', ')+'</div>';
  const a=DATA.assumptions;h+='</div><div class="card"><h3 style="margin-top:0">비용 가정</h3><table><tr><td>국내 수수료</td><td class="r num">'+pabs(a.krxCommission,3)+' (매수·매도 각각)</td></tr><tr><td>국내 주식 매도세</td><td class="r num">'+pabs(a.krxSellTaxStock,2)+'</td></tr><tr><td>국내 ETF 매도세</td><td class="r num">'+pabs(a.krxSellTaxEtf,2)+' ⚠️</td></tr><tr><td>업비트 수수료</td><td class="r num">'+pabs(a.upbitFee,2)+' · 최소 '+won(a.upbitMinOrder)+'</td></tr><tr><td>미끄러짐(불리한 체결)</td><td class="r num">국내 '+pabs(a.slippage.krx,2)+' · 코인 '+pabs(a.slippage.crypto,2)+'</td></tr></table><div class="notice">⚠️ '+esc(a.etfTaxNote)+'</div></div>';return h}
// ---- 알림 설정 (owner-only; POST JSON same-origin) ----
let NS=null;const TIMES=[];for(let i=0;i<144;i++)TIMES.push(String(Math.floor(i/6)).padStart(2,'0')+':'+String(i%6*10).padStart(2,'0'));
const tsel=(name,v,label)=>'<select name="'+name+'" aria-label="'+label+'">'+TIMES.map(t=>'<option'+(t===v?' selected':'')+'>'+t+'</option>').join('')+'</select>';
const CATS=[['lifecycle','승격·중단','전략이 실거래 후보가 되거나 멈출 때'],['crypto','코인 위험 신호','청산 전용·알트 보류 같은 경보'],['data','데이터 오류','시세·지표 수집이 실패할 때']];
const MODES=[['instant','즉시'],['summary','요약에 포함'],['off','끄기']];
function notifyCard(n){const s=n.settings;const times=s.summaryTimes.length?s.summaryTimes:[];
  let h='<h3 style="margin-top:0">알림 설정 (텔레그램)</h3>';
  h+='<div class="meta">'+(n.telegram?'<span class="ck ok">✓</span>텔레그램 연결됨':'<span class="ck no">–</span>텔레그램 미연결 — 배포 스크립트의 텔레그램 연결을 먼저 하세요')+'</div>';
  h+='<div class="meta">다음 요약: '+(n.next.length?esc(n.next[0].at)+(n.next[0].deferred?' (방해 금지 뒤)':''):'없음')+(n.queued?' · 요약 대기 중 알림 '+n.queued+'건':'')+'</div>';
  h+='<form class="nf" id="nform"><div><div class="lbl">하루 요약 시각 <span class="meta">(한국 시간 · 10분 단위 · 최대 4개)</span></div><div class="trow" id="tlist">'+times.map((t,i)=>'<span class="t">'+tsel('time',t,'요약 시각 '+(i+1))+'<button type="button" class="ghost" data-rm="'+i+'" aria-label="이 시각 빼기">×</button></span>').join('')+(times.length<4?'<button type="button" class="ghost" id="tadd">+ 시각 추가</button>':'')+'</div>'+(times.length?'':'<div class="meta">하루 요약을 보내지 않습니다.</div>')+'</div>';
  h+='<div><div class="lbl">요약 보내는 날</div><div class="opt"><label><input type="radio" name="days" value="weekdays"'+(s.summaryDays==='weekdays'?' checked':'')+'>평일만</label><label><input type="radio" name="days" value="daily"'+(s.summaryDays==='daily'?' checked':'')+'>매일</label></div></div>';
  h+='<div><div class="lbl">일이 생겼을 때 알림</div><div style="display:grid;gap:10px">'+CATS.map(([k,name,sub])=>'<div class="crow"><div class="n">'+name+' <span class="meta">'+sub+'</span></div><div class="opt">'+MODES.map(([m,lab])=>'<label><input type="radio" name="ev_'+k+'" value="'+m+'"'+(s.events[k]===m?' checked':'')+'>'+lab+'</label>').join('')+'</div></div>').join('')+'</div></div>';
  h+='<div><label class="sw"><input type="checkbox" name="quiet"'+(s.quiet.enabled?' checked':'')+'>방해 금지 시간</label><div class="trow" style="margin-top:6px">'+tsel('qs',s.quiet.start,'방해 금지 시작')+'<span class="meta">부터</span>'+tsel('qe',s.quiet.end,'방해 금지 끝')+'<span class="meta">까지</span></div><div class="meta">이 시간에 생긴 즉시 알림은 다음 하루 요약에 함께 보냅니다. 요약 시각이 이 시간에 걸리면 끝나는 시각에 보냅니다.</div></div>';
  h+='<div class="trow"><button class="pri" type="submit">저장</button><button type="button" class="ghost" id="ntest"'+(n.telegram?'':' disabled')+'>테스트 보내기</button><button type="button" class="ghost" id="nsum"'+(n.telegram?'':' disabled')+'>요약 미리보기 보내기</button><span class="meta" id="nmsg" role="status"></span></div></form>';
  return h}
function readForm(f){const fd=new FormData(f);const ev={};CATS.forEach(([k])=>ev[k]=fd.get('ev_'+k));
  return {summaryTimes:fd.getAll('time'),summaryDays:fd.get('days'),events:ev,quiet:{enabled:fd.get('quiet')==='on',start:fd.get('qs'),end:fd.get('qe')}}}
async function postJson(url,body){const r=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let d=null;try{d=await r.json()}catch(e){}if(!r.ok)throw new Error((d&&d.error)||('서버 응답 '+r.status));return d}
function wireNotify(){const c=$('#ncard');if(!c||!NS)return;c.innerHTML=notifyCard(NS);const f=$('#nform');const msg=t=>{$('#nmsg').textContent=t};
  f.addEventListener('input',()=>{NDIRTY=true});f.addEventListener('change',()=>{NDIRTY=true});
  const redraw=(s)=>{NS={...NS,settings:s};wireNotify();NDIRTY=true};
  const add=$('#tadd');if(add)add.addEventListener('click',()=>{const s=readForm(f);const t=['08:40','16:00','12:00','20:00','09:00'].find(x=>!s.summaryTimes.includes(x))||'12:10';s.summaryTimes.push(t);redraw(s)});
  f.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',()=>{const s=readForm(f);s.summaryTimes.splice(+b.dataset.rm,1);redraw(s)}));
  f.addEventListener('submit',async e=>{e.preventDefault();const btn=f.querySelector('button[type=submit]');btn.disabled=true;msg('저장하는 중…');
    try{const r=await postJson('/api/notify/settings',{settings:readForm(f)});NS=r.status;NDIRTY=false;wireNotify();$('#nmsg').textContent='저장했어요 ✓'}catch(err){msg(err.message)}finally{btn.disabled=false}});
  const t=$('#ntest');if(t)t.addEventListener('click',async()=>{msg('보내는 중…');try{const r=await postJson('/api/notify/test',{mode:'test'});msg(r.sent?'보냄 ✓':(r.error||'보내지 못했어요'))}catch(err){msg(err.message)}});
  const sm=$('#nsum');if(sm)sm.addEventListener('click',async()=>{msg('보내는 중…');try{const r=await postJson('/api/notify/test',{mode:'summary'});msg(r.sent?'요약 미리보기를 보냈어요 ✓':(r.error||'보내지 못했어요'))}catch(err){msg(err.message)}})}
async function loadNotify(){if(NS){wireNotify();return}try{const r=await fetch('/api/notify/settings',{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw new Error('서버 응답 '+r.status);NS=await r.json();if(TAB==='data')wireNotify()}
  catch(e){const c=$('#ncard');if(c)c.innerHTML='<h3 style="margin-top:0">알림 설정 (텔레그램)</h3><div class="empty">설정을 불러오지 못했습니다. ('+esc(e.message)+') <button class="ghost" id="nretry">다시</button></div>';const b=$('#nretry');if(b)b.addEventListener('click',()=>{NS=null;loadNotify()})}}
function viewLog(){return '<div class="card"><h3 style="margin-top:0">최근 기록</h3>'+(DATA.events.length?'<table>'+DATA.events.map(e=>'<tr><td class="meta num" style="width:110px">'+kst(e.t)+'</td><td class="reason">'+esc(e.message)+'</td></tr>').join('')+'</table>':'<div class="empty">아직 기록이 없습니다.</div>')+'</div>'}
function render(){const v={rank:viewRank,life:viewLife,alloc:viewAlloc,data:viewData,log:viewLog}[TAB]();const m=$('#main');for(const k in CURVES)delete CURVES[k];m.innerHTML=v;wireCharts(m,CURVES);
  const mb=$('#mbar');if(mb)mb.addEventListener('click',()=>{TAB='data';render();window.scrollTo(0,0)});
  const tg=$('#tg');if(tg)tg.addEventListener('click',async()=>{try{const r=await fetch('/api/admin/test-telegram',{method:'POST'});tg.textContent=(await r.json()).sent?'보냄 ✓':'실패'}catch(e){tg.textContent='실패'}});
  if(TAB==='data')loadNotify();
  m.querySelectorAll('.strat').forEach(el=>el.addEventListener('click',e=>{if(e.target.closest('.detail'))return;el.classList.toggle('open');wireCharts(el,CURVES)}));
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.tab===TAB))}
// ---- robust loading: friendly message + retry with backoff, keep last good data (memory + localStorage) ----
const LS='fip:overview:v1',REFRESH_MS=2*60*1000;let LOADING=false,FAILS=0,TIMER=null,LAST_TRY=0,STALE=false,NDIRTY=false;
function agoText(t){if(!t)return'';const m=Math.max(0,Math.round((Date.now()/1000-t)/60));return m<1?'방금':m<60?m+'분 전':Math.floor(m/60)+'시간 '+(m%60)+'분 전'}
function hhmm(t){return kst(t).slice(11,16)}
function setUpd(){if(!DATA){return}const t=DATA.cachedAt||DATA.now;$('#upd').textContent='갱신 '+hhmm(t)+' ('+agoText(t)+')'+(STALE?' · 저장된 자료':'')+(DATA.market&&DATA.market.krxOpen?' · 국내장 열림':'')}
function banner(msg){const b=$('#banner');if(!msg){b.classList.remove('on');b.innerHTML='';return}b.innerHTML=esc(msg)+' <button class="ghost" id="retry">지금 다시</button>';b.classList.add('on');$('#retry').addEventListener('click',()=>load(true))}
function plan(ms){clearTimeout(TIMER);TIMER=null;if(document.visibilityState==='visible')TIMER=setTimeout(()=>load(),ms)}
function valid(d){return d&&typeof d==='object'&&Array.isArray(d.strategies)&&d.data&&d.market}
async function load(manual){if(LOADING)return;LOADING=true;LAST_TRY=Date.now();$('#spin').classList.add('on');
  try{const ctl=new AbortController();const to=setTimeout(()=>ctl.abort(),25000);let r;
    try{r=await fetch('/api/overview',{cache:'no-store',credentials:'same-origin',signal:ctl.signal})}finally{clearTimeout(to)}
    if(r.status===401){location.reload();return}
    const ct=r.headers.get('content-type')||'';if(!r.ok||ct.indexOf('json')<0)throw new Error(r.status===503||r.status>=520?'서버가 잠시 바쁩니다':'서버 응답 '+r.status);
    let d;try{d=await r.json()}catch(e){throw new Error('응답을 읽지 못했습니다')}
    if(!valid(d))throw new Error(d&&d.error?'서버 오류':'응답 형식이 올바르지 않습니다');
    DATA=d;STALE=false;FAILS=0;banner('');try{localStorage.setItem(LS,JSON.stringify(d))}catch(e){}
    if(!(TAB==='data'&&NDIRTY))safeRender();setUpd();plan(REFRESH_MS)}
  catch(e){FAILS++;const wait=Math.min(120,5*Math.pow(2,FAILS-1));
    if(!DATA){try{const c=JSON.parse(localStorage.getItem(LS)||'null');if(valid(c)){DATA=c;STALE=true;safeRender();setUpd()}}catch(_){}}
    banner((e&&e.name==='AbortError'?'서버 응답이 너무 늦습니다':(e&&e.message)||'연결 문제')+'. '+wait+'초 뒤 자동으로 다시 시도합니다.'+(DATA?' 아래는 마지막으로 받은 자료입니다.':''));
    if(!DATA)$('#main').innerHTML='<div class="card"><div class="empty">아직 자료를 받지 못했습니다. 잠시 뒤 자동으로 다시 시도합니다.</div><div class="skel"></div><div class="skel" style="width:70%"></div></div>';
    plan(wait*1000)}
  finally{LOADING=false;$('#spin').classList.remove('on')}}
function safeRender(){const open=[...document.querySelectorAll('.strat.open')].map(el=>el.dataset.id);const y=window.scrollY;
  try{render();open.forEach(id=>{const el=document.querySelector('.strat[data-id="'+CSS.escape(id)+'"]');if(el){el.classList.add('open');wireCharts(el,CURVES)}});window.scrollTo(0,y)}
  catch(e){$('#main').innerHTML='<div class="card"><div class="empty">화면을 그리는 중 문제가 생겼습니다. [새로고침]을 눌러 주세요.</div></div>'}}
document.querySelectorAll('nav button').forEach(b=>b.addEventListener('click',()=>{TAB=b.dataset.tab;NDIRTY=false;if(DATA)safeRender()}));
$('#refresh').addEventListener('click',()=>load(true));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){if(Date.now()-LAST_TRY>30000)load();else plan(REFRESH_MS)}else{clearTimeout(TIMER);TIMER=null}});
window.addEventListener('focus',()=>{if(Date.now()-LAST_TRY>30000)load()});
window.addEventListener('online',()=>load());
setInterval(setUpd,30000);
try{const c=JSON.parse(localStorage.getItem(LS)||'null');if(valid(c)){DATA=c;STALE=true;safeRender();setUpd()}}catch(e){}
load();
`;

export function dashboardHtml() {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>모의투자 연구실</title><style>${CSS}</style></head><body><div class="wrap">
<header><div class="logo">모의</div><div><h1>모의투자 연구실</h1><div class="sub"><span id="upd">불러오는 중…</span><span class="spin" id="spin" aria-hidden="true"></span></div></div><span class="paper-badge">가상 돈 · 실제 주문 없음</span></header>
<nav><button data-tab="rank" class="on">전략 순위</button><button data-tab="life">수명주기</button><button data-tab="alloc">운용 매니저</button><button data-tab="data">데이터·비용</button><button data-tab="log">기록</button></nav>
<div class="banner" id="banner" role="alert"></div>
<main id="main"><div class="card"><div class="empty">불러오는 중…</div><div class="skel"></div><div class="skel" style="width:80%"></div><div class="skel" style="width:60%"></div></div></main>
<footer>이 화면은 학습·검증용 모의투자 기록입니다. 투자 권유가 아니며, 과거·모의 성과가 미래 수익을 보장하지 않습니다. 이 프로그램은 증권사·거래소에 주문을 보내는 기능이 없습니다.<br><button class="ghost" id="refresh">새로고침</button> <form method="post" action="/logout" style="display:inline"><button class="ghost">로그아웃</button></form></footer>
</div><script>${JS}</script></body></html>`;
}

export function loginHtml(msg) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>모의투자 연구실 · 로그인</title><style>${CSS}
.login{max-width:360px;margin:12vh auto;padding:0 16px}input{width:100%;font:inherit;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);margin:10px 0}.go{width:100%;padding:12px;border:0;border-radius:12px;background:var(--brand);color:#fff;font:inherit;font-weight:700;cursor:pointer}.err{color:var(--bad);font-size:13px}</style></head><body><div class="login">
<div class="row" style="margin-bottom:14px"><div class="logo">모의</div><div><h1>모의투자 연구실</h1><div class="sub">주인 전용 · 가상 돈 · 실제 주문 없음</div></div></div>
<form class="card" method="post" action="/login"><label for="pw" style="font-size:13px;font-weight:600">관리자 비밀번호</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>${msg ? `<div class="err">${msg.replace(/[<>&]/g, '')}</div>` : ''}<button class="go">들어가기</button></form>
</div></body></html>`;
}
