import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || process.env.PASEO_PORT || 3000);

const STYLE = `
:root{color-scheme:light;--text:#20272d;--muted:#59636b;--rule:#d5dadd;--blue:#244f6b;--mono:ui-monospace,SFMono-Regular,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5}
header,main,footer{max-width:896px;margin:0 auto;padding:0 28px}
header{padding-top:38px;padding-bottom:24px}
h1{margin:0;font-size:28px;font-weight:600;letter-spacing:-.025em}
.version{margin:2px 0 0;font:13px var(--mono);color:var(--muted)}
.meta{margin:0;font:12px/1.6 var(--mono);color:var(--muted);font-variant-numeric:tabular-nums}
figure{margin:0;padding:20px 0 24px;border-top:1px solid var(--rule)}
figure:first-of-type{border-top:0;padding-top:0}
.figure-heading{display:flex;justify-content:space-between;align-items:baseline;gap:8px 24px;flex-wrap:wrap}
h2{margin:0;font-size:15px;font-weight:600}
figcaption{margin-bottom:12px}
.refresh{margin-top:8px}
.refresh time{white-space:nowrap}
.methodology{padding-bottom:30px}
.methodology h2{margin:24px 0 8px}
.methodology h2:first-child{margin-top:0}
.methodology p{margin:0 0 12px;max-width:78ch}
.methodology .meta{margin-bottom:20px}
.legend{display:flex;gap:20px;flex-wrap:wrap;margin:0 0 8px;color:var(--muted);font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.swatch{display:inline-block;width:22px;border-top:2px solid var(--blue)}
.swatch.hiring{border-top:2px dashed #737373}
svg{width:100%;height:auto;display:block;font-family:var(--mono);font-variant-numeric:tabular-nums;touch-action:pan-y}
svg:focus-visible,a:focus-visible{outline:2px solid var(--blue);outline-offset:4px}
#tip{position:fixed;pointer-events:none;background:#fff;color:var(--text);border:1px solid #929ba2;padding:8px 10px;font:12px/1.65 var(--mono);display:none;z-index:10;max-width:calc(100vw - 24px)}
footer{padding-bottom:30px;color:var(--muted);font-size:12px}
.footer-content{border-top:1px solid var(--rule);padding-top:14px}
footer p{margin:0 0 6px}
.links{display:flex;gap:18px;flex-wrap:wrap}
a{color:var(--blue);text-underline-offset:3px}
#status{color:var(--muted)}
#status:empty{display:none}
@media(max-width:520px){header,main,footer{padding-left:18px;padding-right:18px}header{padding-top:24px}h1{font-size:25px}.figure-heading{gap:4px}}
`;

const FOOTER_CREDITS = `<p>Built with <a href="https://agentduel.com">agent duel</a> <a href="https://github.com/bottomless/agent-duel">[github]</a></p>
    <p>Built by <a href="https://micjm.com">micjm</a> <a href="https://micjm.com/blog/hn-hiring-index-agent-duel/">[blog]</a></p>`;

export const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>HN Hiring Index — v0.1</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>HN Hiring Index</h1>
  <p class="version">v0.1</p>
  <p class="meta refresh">Last refresh: <time id="last-refresh">—</time> (data based on 21 days, index refreshes on 22nd of each month)</p>
</header>
<main>
  <p id="status" role="status"></p>
  <noscript><p>JavaScript is required to display the charts. Data downloads are on the <a href="./methodology/">Methodology page</a>.</p></noscript>
  <figure aria-labelledby="index-title">
    <figcaption>
      <div class="figure-heading">
        <h2 id="index-title">Hiring index</h2>
        <span class="meta" id="latest"></span>
      </div>
    </figcaption>
    <div id="chart-index"></div>
  </figure>
  <figure aria-labelledby="components-title">
    <figcaption>
      <h2 id="components-title">Component series</h2>
      <div class="legend"><span><i class="swatch" aria-hidden="true"></i>Seeker comments</span><span><i class="swatch hiring" aria-hidden="true"></i>Hiring comments</span></div>
    </figcaption>
    <div id="chart-components"></div>
  </figure>
</main>
<footer>
  <div class="footer-content">
    <p><a href="./methodology/">Methodology</a></p>
    ${FOOTER_CREDITS}
  </div>
</footer>
<div id="tip" role="status" aria-live="polite"></div>
<script type="module">
const tip = document.getElementById("tip");
const status = document.getElementById("status");
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMonth = m => MONTHS[Number(m.slice(5)) - 1] + " " + m.slice(0, 4);
const fmt = v => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(v);
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");

function chart(elId, months, { title, series, reference, tooltip }) {
  const el = document.getElementById(elId);
  const width = Math.max(280, el.clientWidth), height = width < 520 ? 260 : 300;
  const pad = { top: 30, right: 20, bottom: 32, left: 40 };
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const n = months.length;
  const peak = Math.max(...series.flatMap(s => s.values));
  const step = Math.max(100, Math.ceil(peak / 600) * 100);
  const yMax = Math.max(200, Math.ceil(peak * 1.08 / step) * step);
  const xAt = i => pad.left + (i / Math.max(1, n - 1)) * w;
  const yAt = v => pad.top + h - (v / yMax) * h;
  const latest = series.map(s => s.label + ": " + fmt(s.values.at(-1))).join("; ");

  let o = \`<svg viewBox="0 0 \${width} \${height}" role="img" tabindex="0" aria-labelledby="\${elId}-title" aria-describedby="\${elId}-desc">
    <title id="\${elId}-title">\${esc(title)}</title>
    <desc id="\${elId}-desc">\${fmtMonth(months[0])} to \${fmtMonth(months.at(-1))}. Latest: \${esc(latest)}. Use left and right arrow keys to inspect months.</desc>
    <text x="\${pad.left}" y="13" font-size="11" fill="#59636b">Index · \${esc(reference)} = 100</text>\`;

  const ticks = [...new Set([100, ...Array.from({ length: yMax / step + 1 }, (_, i) => i * step)])].sort((a, b) => a - b);
  for (const t of ticks) {
    const y = yAt(t);
    o += \`<line x1="\${pad.left}" y1="\${y}" x2="\${width - pad.right}" y2="\${y}" stroke="\${t === 100 ? "#929ba2" : t === 0 ? "#b7bfc5" : "#e8ebed"}"\${t === 100 ? ' stroke-dasharray="3 4"' : ""}/>
      <text x="\${pad.left - 10}" y="\${y + 4}" text-anchor="end" font-size="11" fill="#59636b">\${t}</text>\`;
  }

  let lastTick = -Infinity;
  months.forEach((m, i) => {
    if (i !== 0 && !(m.endsWith("-01") && Number(m.slice(0, 4)) % 2 === 0)) return;
    const x = xAt(i);
    if (x - lastTick < 60) return;
    lastTick = x;
    o += \`<line x1="\${x}" y1="\${pad.top + h}" x2="\${x}" y2="\${pad.top + h + 4}" stroke="#b7bfc5"/>
      <text x="\${x}" y="\${height - 10}" text-anchor="middle" font-size="11" fill="#59636b">\${m.slice(0, 4)}</text>\`;
  });

  for (const s of series) {
    const d = s.values.map((v, i) => (i === 0 ? "M" : "L") + xAt(i).toFixed(1) + "," + yAt(v).toFixed(1)).join(" ");
    o += \`<path d="\${d}" fill="none" stroke="\${s.color}" stroke-width="1.8" stroke-linejoin="round"\${s.dash ? ' stroke-dasharray="6 3"' : ""}/>
      <circle cx="\${xAt(n - 1)}" cy="\${yAt(s.values.at(-1))}" r="2.8" fill="\${s.color}"/>\`;
  }
  o += \`<line class="xh" y1="\${pad.top}" y2="\${pad.top + h}" stroke="#929ba2" opacity="0"/>\`;
  for (const s of series) o += \`<circle class="dot" r="3.5" fill="\${s.color}" stroke="#fff" stroke-width="1.2" opacity="0"/>\`;
  o += \`<rect class="hit" x="\${pad.left}" y="\${pad.top}" width="\${w}" height="\${h}" fill="transparent"/></svg>\`;
  el.innerHTML = o;

  const svg = el.querySelector("svg");
  const xh = svg.querySelector(".xh"), dots = [...svg.querySelectorAll(".dot")];
  let selected = n - 1;
  const show = (i, clientX, clientY) => {
    selected = i;
    xh.setAttribute("x1", xAt(i)); xh.setAttribute("x2", xAt(i)); xh.setAttribute("opacity", "1");
    dots.forEach((d, k) => { d.setAttribute("cx", xAt(i)); d.setAttribute("cy", yAt(series[k].values[i])); d.setAttribute("opacity", "1"); });
    tip.innerHTML = tooltip(i);
    tip.style.display = "block";
    tip.style.left = Math.max(12, Math.min(innerWidth - tip.offsetWidth - 12, clientX + 14)) + "px";
    tip.style.top = Math.max(12, Math.min(innerHeight - tip.offsetHeight - 12, clientY + 16)) + "px";
  };
  const hide = () => {
    tip.style.display = "none";
    xh.setAttribute("opacity", "0");
    dots.forEach(d => d.setAttribute("opacity", "0"));
  };
  const inspect = ev => {
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (width / r.width);
    const i = Math.max(0, Math.min(n - 1, Math.round(((x - pad.left) / w) * (n - 1))));
    show(i, ev.clientX, ev.clientY);
  };
  svg.querySelector(".hit").addEventListener("pointermove", inspect);
  svg.querySelector(".hit").addEventListener("pointerdown", inspect);
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { hide(); return; }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) return;
    ev.preventDefault();
    const i = ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : Math.max(0, Math.min(n - 1, selected + (ev.key === "ArrowRight" ? 1 : -1)));
    const r = svg.getBoundingClientRect();
    show(i, r.left + xAt(i) * r.width / width, r.top + pad.top);
  });
}

try {
  status.textContent = "Loading data…";
  const response = await fetch("./data/index.json");
  if (!response.ok) throw new Error("Data unavailable");
  const D = await response.json();
  const idx = D.index;
  if (!Array.isArray(idx) || !idx.length || !idx.every(r => [r.badness_index_21d, r.wants_index_21d, r.hiring_index_21d].every(Number.isFinite))) throw new Error("Invalid index data");
  const months = idx.map(r => r.month), last = idx.at(-1);
  const values = idx.map(r => r.badness_index_21d);
  const wants = idx.map(r => r.wants_index_21d);
  const hiring = idx.map(r => r.hiring_index_21d);
  document.getElementById("latest").textContent = fmtMonth(last.month) + " · " + fmt(values.at(-1));
  if (D.index_updated_at) {
    const refreshed = document.getElementById("last-refresh");
    refreshed.dateTime = D.index_updated_at;
    refreshed.textContent = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(D.index_updated_at));
  }
  status.textContent = "";

  const render = () => {
    tip.style.display = "none";
    chart("chart-index", months, {
      title: "HN Hiring Index",
      reference: "reference",
      series: [{ label: "Hiring index", color: "#244f6b", values }],
      tooltip: i => \`<b>\${fmtMonth(months[i])}</b><br>Hiring index: \${fmt(values[i])}<br>Seeker comments: \${fmt(idx[i].wants_raw_21d)}<br>Hiring comments: \${fmt(idx[i].hiring_raw_21d)}<br>Raw comment ratio: \${fmt(idx[i].seekers_per_employer_21d)}\`,
    });
    chart("chart-components", months, {
      title: "Seeker and hiring comment indexes",
      reference: "period mean",
      series: [
        { label: "Seeker component", color: "#244f6b", values: wants },
        { label: "Hiring component", color: "#737373", dash: true, values: hiring },
      ],
      tooltip: i => \`<b>\${fmtMonth(months[i])}</b><br>Seeker component: \${fmt(wants[i])}<br>Hiring component: \${fmt(hiring[i])}\`,
    });
  };
  render();
  let lastWidth = document.querySelector("main").clientWidth;
  new ResizeObserver(([entry]) => {
    const width = entry.target.clientWidth;
    if (width !== lastWidth) { lastWidth = width; render(); }
  }).observe(document.querySelector("main"));
} catch {
  status.textContent = "Unable to load chart data. Reload the page or use the data downloads linked from Methodology below.";
}
</script>
</body>
</html>`;

export function methodology(data) {
  const fmtMonth = month => new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(month + "-01T00:00:00Z"));
  const period = fmtMonth(data.base_period.start) + "–" + fmtMonth(data.base_period.end);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Methodology — HN Hiring Index v0.1</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Methodology</h1>
  <p class="version">HN Hiring Index · v0.1</p>
</header>
<main class="methodology">
  <h2>Data</h2>
  <p>Monthly activity in Hacker News “Who is hiring?” and “Who wants to be hired?” threads.</p>
  <p class="meta">${period} · ${data.index.length} months · seasonally adjusted</p>
  <p>Each observation counts top-level comments in the first 21 days of a thread; nested replies are excluded. Months without a complete 21-day window are excluded. Freelancer threads are not included in the index.</p>
  <h2>Hiring index</h2>
  <p>The first figure shows 100 × seeker component / hiring component. Higher values mean more seeker posts relative to hiring posts.</p>
  <p>The dashed line at 100 marks equal component levels relative to their respective means, not equal raw comment counts. It is a reference, not the average of the hiring index.</p>
  <h2>Component series</h2>
  <p>The second figure shows seeker comments (solid blue) and hiring comments (dashed gray). Each series is seasonally adjusted separately and indexed to its own mean = 100 over ${period}.</p>
  <p>Seasonal adjustment uses five passes of a centered 12-month moving-average trend and median month-of-year ratios. Both figures display monthly values without additional smoothing.</p>
  <h2>Sources and limits</h2>
  <p>Official HN threads are collected through the HN API; Algolia supplies top-level comments (<code>parent_id = story_id</code>) and their timestamps for the fixed windows. Only top-level entries are counted, excluding nested replies under listings, though one employer post can cover multiple roles and people or companies may repost across months. HN is not representative of the whole job market.</p>
  <p class="links"><a href="../data/index.csv">Index data (CSV)</a><a href="../data/posts.csv">Thread data (CSV)</a><a href="../data/index.json">Index and method details (JSON)</a></p>
</main>
<footer><div class="footer-content"><p><a href="../">Back to charts</a></p>${FOOTER_CREDITS}</div></footer>
</body>
</html>`;
}

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.html") { res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(HTML); return; }
    if (url.pathname === "/methodology" || url.pathname === "/methodology/") {
      const data = JSON.parse(await fs.readFile(path.join(ROOT, "data/index.json"), "utf8"));
      const html = methodology(data);
      res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(html); return;
    }
    if (url.pathname.startsWith("/data/") || url.pathname.startsWith("/plots/")) {
      const p = path.resolve(ROOT, "." + url.pathname);
      if (!p.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
      const data = await fs.readFile(p);
      res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(data); return;
    }
    res.writeHead(404); res.end("Not found");
  } catch { res.writeHead(404); res.end("Not found"); }
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`HN Hiring Index on http://${HOST}:${PORT}`));
}
