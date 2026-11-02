import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || process.env.PASEO_PORT || 3000);

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>The HN job market is bad</title>
<style>
:root{--bg:#faf9f7;--card:#fff;--border:#e7e2da;--text:#1c1917;--muted:#78716c;--red:#dc2626;--blue:#2563eb}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
header,main{max-width:728px;margin:0 auto;padding:0 20px}
header{padding-top:30px}
h1{margin:0;font-size:25px;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:14px;margin-top:6px}
.def{background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:9px 12px;font-size:13px;margin-top:12px;line-height:1.5}
main{padding-top:14px;padding-bottom:44px;display:grid;gap:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 16px 8px;position:relative}
.card h2{margin:0;font-size:15.5px}
.card p{margin:4px 0 6px;font-size:13px;color:var(--muted)}
svg{width:100%;height:auto;display:block}
#tip{position:fixed;pointer-events:none;background:rgba(28,25,23,.94);color:#fff;padding:8px 11px;border-radius:7px;font-size:12.5px;line-height:1.5;display:none;z-index:50;white-space:nowrap}
#tip b{font-size:13.5px}
.foot{font-size:12px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;padding:2px 4px}
.foot a{color:var(--blue);text-decoration:none}
</style>
</head>
<body>
<header>
  <h1>The HN job market is bad</h1>
  <div class="sub">Monthly Hacker News “Who is hiring?” vs “Who wants to be hired?” threads · seasonally adjusted · Jul 2014 – Oct 2026 (148 months)</div>
  <div class="def"><b>Badness Index</b> = 100 × seeker volume ÷ employer-post volume. <b>100</b> = average for 2014–2026 · <b>200</b> = twice as bad · <b>50</b> = half as bad. Higher = worse for job seekers. Monthly values only — no smoothing.</div>
</header>
<main>
  <div class="card">
    <h2 id="bad-title"></h2>
    <p id="bad-sub"></p>
    <div id="chart-badness"></div>
  </div>
  <div class="card">
    <h2>What drives it: job seekers vs employer posts</h2>
    <p>Each series deseasonalized on its own, then indexed (100 = its 2014–2026 average). The Badness Index above is the red line divided by the blue line — so growth in HN's overall audience cancels out.</p>
    <div id="chart-components"></div>
  </div>
  <div class="foot">
    <span>Source: official <i>whoishiring</i> threads via the HN API · Nov 2026 excluded (thread &lt;1 day old)</span>
    <a href="/data/index.csv">index.csv</a><a href="/data/posts.csv">posts.csv</a>
    <a href="/plots/06-badness-index.svg">badness.svg</a><a href="/plots/05-index-deseasonalized.svg">components.svg</a>
  </div>
</main>
<div id="tip"></div>
<script type="module">
const D = await (await fetch("/data/index.json")).json();
const idx = D.index, months = idx.map(r => r.month);
const tip = document.getElementById("tip");
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMonth = m => MONTHS[Number(m.slice(5)) - 1] + " " + m.slice(0, 4);

const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");
const PANDEMIC = [{ from: "2020-03", to: "2023-05", label: "pandemic" }];

// Builds a line-chart SVG string and wires a hover crosshair/tooltip on it.
// series: [{label,color,width,values,fill}] — values are monthly, nulls skipped.
function chart(elId, { width = 676, height = 340, series, yMax, yTicks, refLine = 100, shadeFrom = null, bands = [], annotations = [] }) {
  const pad = { top: 22, right: 78, bottom: 32, left: 46 };
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const n = months.length;
  const xAt = i => pad.left + (i / (n - 1)) * w;
  const yAt = v => pad.top + h - (v / yMax) * h;

  let o = \`<svg viewBox="0 0 \${width} \${height}" role="img">\`;
  o += \`<defs><linearGradient id="fill-\${elId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#dc2626" stop-opacity="0.20"/>
          <stop offset="100%" stop-color="#dc2626" stop-opacity="0.01"/></linearGradient></defs>\`;

  for (const b of bands) {
    const i0 = Math.max(0, months.findIndex(m => m >= b.from));
    let i1 = months.findIndex(m => m > b.to); if (i1 < 0) i1 = n - 1;
    o += \`<rect x="\${xAt(i0)}" y="\${pad.top}" width="\${xAt(i1) - xAt(i0)}" height="\${h}" fill="#78716c" opacity="0.10"/>\`;
    o += \`<text x="\${(xAt(i0) + xAt(i1)) / 2}" y="\${pad.top + 14}" text-anchor="middle" font-size="11" fill="#57534e" font-weight="600">\${esc(b.label)}</text>\`;
  }

  if (shadeFrom) {
    const i0 = Math.max(0, months.findIndex(m => m >= shadeFrom));
    o += \`<rect x="\${xAt(i0)}" y="\${pad.top}" width="\${xAt(n - 1) - xAt(i0)}" height="\${h}" fill="#dc2626" opacity="0.045"/>\`;
    o += \`<text x="\${xAt(i0) + 7}" y="\${pad.top + 14}" font-size="11" fill="#b91c1c" font-weight="600">2023 →</text>\`;
  }

  for (const t of yTicks) {
    const y = yAt(t);
    o += \`<line x1="\${pad.left}" y1="\${y}" x2="\${width - pad.right}" y2="\${y}" stroke="\${t === 0 ? "#d6d0c6" : "#efe9e0"}"/>\`;
    o += \`<text x="\${pad.left - 9}" y="\${y + 4}" text-anchor="end" font-size="11" fill="#a8a29e">\${t}</text>\`;
  }
  if (refLine != null) {
    const y = yAt(refLine);
    o += \`<line x1="\${pad.left}" y1="\${y}" x2="\${width - pad.right}" y2="\${y}" stroke="#a8a29e" stroke-dasharray="5 4" stroke-width="1.2"/>\`;
    o += \`<text x="\${width - pad.right + 8}" y="\${y + 4}" font-size="10.5" fill="#78716c">average = \${refLine}</text>\`;
  }
  months.forEach((m, i) => {
    if ((m.endsWith("-01") && Number(m.slice(0, 4)) % 2 === 0) || i === 0) o += \`<text x="\${xAt(i)}" y="\${height - 10}" text-anchor="middle" font-size="11.5" fill="#a8a29e">\${m.slice(0, 4)}</text>\`;
  });

  const pathOf = values => {
    let d = "";
    values.forEach((v, i) => { if (v != null) d += \`\${d === "" || values[i - 1] == null ? "M" : "L"}\${xAt(i).toFixed(1)},\${yAt(v).toFixed(1)} \`; });
    return d.trim();
  };

  for (const s of series) {
    const d = pathOf(s.values);
    if (s.fill) {
      const first = s.values.findIndex(v => v != null), last = s.values.length - 1 - [...s.values].reverse().findIndex(v => v != null);
      o += \`<path d="\${d} L\${xAt(last).toFixed(1)},\${yAt(0)} L\${xAt(first).toFixed(1)},\${yAt(0)} Z" fill="url(#fill-\${elId})" stroke="none"/>\`;
    }
    o += \`<path d="\${d}" fill="none" stroke="\${s.color}" stroke-width="\${s.width || 2.4}" stroke-linejoin="round" stroke-linecap="round"/>\`;
    const li = s.values.length - 1;
    o += \`<circle cx="\${xAt(li)}" cy="\${yAt(s.values[li])}" r="4" fill="\${s.color}" stroke="#fff" stroke-width="1.6"/>\`;
    o += \`<text x="\${xAt(li) + 10}" y="\${yAt(s.values[li]) + 4}" font-size="12.5" font-weight="700" fill="\${s.color}">\${Math.round(s.values[li])}</text>\`;
    o += \`<text x="\${xAt(li) + 10}" y="\${yAt(s.values[li]) + 20}" font-size="10" fill="#78716c">\${esc(s.endLabel)}</text>\`;
  }

  for (const a of annotations) {
    const i = months.indexOf(a.month);
    if (i < 0) continue;
    const v = series[a.series ?? 0].values[i];
    const x = xAt(i), y = yAt(v);
    const dy = a.dy ?? -14, anchor = a.anchor ?? "middle";
    o += \`<circle cx="\${x}" cy="\${y}" r="4" fill="\${series[a.series ?? 0].color}" stroke="#fff" stroke-width="1.6"/>\`;
    o += \`<line x1="\${x}" y1="\${y}" x2="\${x}" y2="\${y + dy + (dy < 0 ? 6 : -6)}" stroke="#a8a29e" stroke-width="1"/>\`;
    o += \`<text x="\${a.dx ? x + a.dx : x}" y="\${y + dy}" text-anchor="\${anchor}" font-size="11.5" font-weight="650" fill="#1c1917">\${esc(a.title)}</text>\`;
    if (a.sub) o += \`<text x="\${a.dx ? x + a.dx : x}" y="\${y + dy + 15}" text-anchor="\${anchor}" font-size="10.5" fill="#78716c">\${esc(a.sub)}</text>\`;
  }

  o += \`<line class="xh" y1="\${pad.top}" y2="\${pad.top + h}" stroke="#a8a29e" stroke-width="1" opacity="0"/>\`;
  for (const s of series) o += \`<circle class="dot" r="4.5" fill="\${s.color}" stroke="#fff" stroke-width="1.6" opacity="0"/>\`;
  o += \`<rect class="hit" x="\${pad.left}" y="\${pad.top}" width="\${w}" height="\${h}" fill="transparent"/>\`;
  o += "</svg>";

  const el = document.getElementById(elId);
  el.innerHTML = o;
  const svg = el.querySelector("svg");
  const xh = svg.querySelector(".xh"), dots = [...svg.querySelectorAll(".dot")];

  svg.querySelector(".hit").addEventListener("mousemove", ev => {
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (width / r.width);
    const i = Math.max(0, Math.min(n - 1, Math.round(((x - pad.left) / w) * (n - 1))));
    xh.setAttribute("x1", xAt(i)); xh.setAttribute("x2", xAt(i)); xh.setAttribute("opacity", "0.7");
    dots.forEach((d, k) => { d.setAttribute("cx", xAt(i)); d.setAttribute("cy", yAt(series[k].values[i])); d.setAttribute("opacity", "1"); });
    tip.innerHTML = chart.tip(i);
    tip.style.display = "block";
    tip.style.left = Math.min(innerWidth - tip.offsetWidth - 12, ev.clientX + 14) + "px";
    tip.style.top = (ev.clientY + 16) + "px";
  });
  svg.addEventListener("mouseleave", () => { tip.style.display = "none"; xh.setAttribute("opacity", "0"); dots.forEach(d => d.setAttribute("opacity", "0")); });
  return chart;
}

function render() {
  const basis = "21d";
  const bad = idx.map(r => r["badness_index_" + basis]);
  const wants = idx.map(r => r["wants_index_" + basis]);
  const hiring = idx.map(r => r["hiring_index_" + basis]);
  const lo = idx.reduce((a, r, i) => (bad[i] < bad[a] ? i : a), 0);
  const last = idx.at(-1);

  document.getElementById("bad-title").textContent =
    \`Badness Index — \${fmtMonth(last.month)}: \${Math.round(bad.at(-1))} (worst of \${idx.length} months)\`;
  document.getElementById("bad-sub").textContent =
    "Seasonally adjusted monthly values. Hover for detail.";

  chart("chart-badness", {
    width: 676, height: 330, yMax: 560, yTicks: [0, 100, 200, 300, 400, 500], bands: PANDEMIC,
    series: [{ label: "Badness", color: "#dc2626", width: 2.5, values: bad, fill: true, endLabel: fmtMonth(last.month) }],
    annotations: [
      { month: months[lo], title: \`\${Math.round(bad[lo])} — best month\`, sub: fmtMonth(months[lo]), dy: -22 },
    ],
  });
  const badTip = i => {
    const r = idx[i];
    return \`<b>\${fmtMonth(r.month)}</b><br>Badness: <b>\${Math.round(bad[i])}</b><br>\` +
      \`\${r.wants_raw_21d} seeker comments · \${r.hiring_raw_21d} hiring comments<br>\` +
      \`<span style="color:#d6d3d1">\${r["seekers_per_employer_" + basis]} seekers per employer post</span>\`;
  };
  document.getElementById("chart-badness")._tip = badTip;
  chart.tip = badTip;
  wireTip("chart-badness", badTip);

  chart("chart-components", {
    width: 676, height: 300, yMax: 300, yTicks: [0, 100, 200, 300], bands: PANDEMIC,
    series: [
      { label: "Seekers", color: "#dc2626", width: 2.5, values: wants, endLabel: "seekers" },
      { label: "Employer posts", color: "#2563eb", width: 2.5, values: hiring, endLabel: "employer posts" },
    ],
    annotations: [{ month: "2018-05", series: 1, title: "employer-post peak era", sub: "2017–19", dy: -16 }],
  });
  wireTip("chart-components", i => {
    const r = idx[i];
    return \`<b>\${fmtMonth(r.month)}</b><br><span style="color:#fca5a5">Seekers index: \${Math.round(wants[i])}</span><br>\` +
      \`<span style="color:#93c5fd">Employer-post index: \${Math.round(hiring[i])}</span><br>Badness: <b>\${Math.round(bad[i])}</b>\`;
  });
}

// chart() registers its tooltip via chart.tip at call time; rebind helper keeps both charts live.
function wireTip(elId, fn) {
  const el = document.getElementById(elId);
  const svg = el.querySelector("svg");
  if (!svg) return;
  // The mousemove handler inside chart() calls chart.tip(i); swap it while hovering this chart.
  svg.addEventListener("mouseenter", () => { chart.tip = fn; });
}

render();
</script>
</body>
</html>`;

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.html") { res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(HTML); return; }
    if (url.pathname.startsWith("/data/") || url.pathname.startsWith("/plots/")) {
      const p = path.resolve(ROOT, "." + url.pathname);
      if (!p.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
      const data = await fs.readFile(p);
      res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(data); return;
    }
    res.writeHead(404); res.end("Not found");
  } catch { res.writeHead(404); res.end("Not found"); }
});
server.listen(PORT, HOST, () => console.log(`HN job market preview on http://${HOST}:${PORT}`));
