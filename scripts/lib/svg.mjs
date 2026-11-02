const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FONT = 'font-family="system-ui, -apple-system, sans-serif"';

function frame({ width, height, title, subtitle, pad, yMin, yMax, yFmt, xLabels, zeroLine, xStep }) {
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const xAt = (i) => pad.left + (i / Math.max(1, xLabels.length - 1)) * w;
  const yAt = (v) => pad.top + h - ((v - yMin) / ((yMax - yMin) || 1)) * h;

  let grid = "";
  for (let t = 0; t <= 5; t++) {
    const val = yMin + ((yMax - yMin) * t) / 5;
    const y = yAt(val);
    grid += `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="#e2e8f0"/>`;
    grid += `<text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="11" ${FONT}>${esc(yFmt(val))}</text>`;
  }
  if (zeroLine && yMin < 0 && yMax > 0) {
    grid += `<line x1="${pad.left}" y1="${yAt(0).toFixed(1)}" x2="${width - pad.right}" y2="${yAt(0).toFixed(1)}" stroke="#94a3b8" stroke-dasharray="4 3" stroke-width="1.2"/>`;
  }
  let xAxis = "";
  const step = xStep ?? Math.max(1, Math.floor(xLabels.length / 10));
  for (let i = 0; i < xLabels.length; i += step) {
    xAxis += `<text x="${xAt(i).toFixed(1)}" y="${height - 12}" text-anchor="middle" fill="#64748b" font-size="11" ${FONT}>${esc(xLabels[i])}</text>`;
  }
  let legend = "";
  let lx = pad.left;
  return {
    w, h, xAt, yAt, grid, xAxis,
    addLegend(series) {
      for (const s of series) {
        legend += `<line x1="${lx}" y1="${pad.top - 18}" x2="${lx + 18}" y2="${pad.top - 18}" stroke="${s.color}" stroke-width="${s.width ?? 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""}/>`;
        legend += `<text x="${lx + 23}" y="${pad.top - 14}" fill="#334155" font-size="11.5" ${FONT}>${esc(s.label)}</text>`;
        lx += 40 + s.label.length * 6.4;
      }
    },
    wrap(inner) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background:#fff;border:1px solid #e2e8f0;border-radius:8px">
  <text x="${pad.left}" y="20" fill="#0f172a" font-size="14" font-weight="600" ${FONT}>${esc(title)}${subtitle ? ` — ${esc(subtitle)}` : ""}</text>
  ${legend}${grid}${xAxis}${inner}
</svg>\n`;
    },
  };
}

function pathsFor(f, series) {
  let out = "";
  for (const s of series) {
    let d = "";
    s.values.forEach((v, i) => {
      if (v == null || Number.isNaN(v)) return;
      d += `${d === "" || s.values[i - 1] == null ? "M" : "L"}${f.xAt(i).toFixed(1)},${f.yAt(v).toFixed(1)} `;
    });
    out += `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} opacity="${s.opacity ?? 1}"/>`;
  }
  return out;
}

export function lineSvg({ width = 920, height = 340, title, subtitle, xLabels, series, yMax, yMin = 0, yFmt = (v) => Math.round(v), zeroLine = false, xStep, bands = [] }) {
  const pad = { top: 52, right: 24, bottom: 40, left: 60 };
  const f = frame({ width, height, title, subtitle, pad, yMin, yMax, yFmt, xLabels, zeroLine, xStep });
  f.addLegend(series);
  let inner = "";
  for (const b of bands) {
    const x0 = f.xAt(b.from), x1 = f.xAt(b.to);
    inner += `<rect x="${x0.toFixed(1)}" y="${pad.top}" width="${(x1 - x0).toFixed(1)}" height="${f.h}" fill="#78716c" opacity="0.10"/>`;
    inner += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${pad.top + 14}" text-anchor="middle" fill="#57534e" font-size="11" font-weight="600" ${FONT}>${esc(b.label)}</text>`;
  }
  return f.wrap(inner + pathsFor(f, series));
}

export function scatterSvg({ width = 520, height = 380, title, subtitle, points, xMax, yMax, xLabel, yLabel, refLine = true, fit }) {
  const pad = { top: 52, right: 24, bottom: 48, left: 60 };
  const f = frame({
    width, height, title, subtitle, pad, yMin: 0, yMax, xLabels: [], yFmt: (v) => Math.round(v), xStep: 1,
  });
  const px = (v) => pad.left + (v / (xMax || 1)) * f.w;
  const py = (v) => pad.top + f.h - (v / (yMax || 1)) * f.h;
  let inner = "";
  if (refLine) {
    inner += `<line x1="${px(0)}" y1="${py(0)}" x2="${px(Math.min(xMax, yMax))}" y2="${py(Math.min(xMax, yMax))}" stroke="#cbd5e1" stroke-dasharray="5 4"/>`;
  }
  if (fit) inner += `<line x1="${px(0)}" y1="${py(fit.intercept)}" x2="${px(xMax)}" y2="${py(fit.slope * xMax + fit.intercept)}" stroke="#0f172a" stroke-width="1.6" opacity="0.55"/>`;
  for (const p of points) {
    inner += `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="${p.r ?? 3}" fill="${p.color}" opacity="${p.opacity ?? 0.65}"><title>${esc(p.label ?? "")}</title></circle>`;
  }
  inner += `<text x="${pad.left + f.w / 2}" y="${height - 8}" text-anchor="middle" fill="#475569" font-size="11.5" ${FONT}>${esc(xLabel)}</text>`;
  inner += `<text x="14" y="${pad.top + f.h / 2}" text-anchor="middle" fill="#475569" font-size="11.5" transform="rotate(-90 14 ${pad.top + f.h / 2})" ${FONT}>${esc(yLabel)}</text>`;
  const step = Math.max(1, Math.floor(6));
  for (let i = 0; i <= step; i++) {
    const v = (xMax * i) / step;
    inner += `<text x="${px(v).toFixed(1)}" y="${height - 26}" text-anchor="middle" fill="#64748b" font-size="11" ${FONT}>${Math.round(v)}</text>`;
  }
  f.addLegend([{ label: "each dot = one month", color: "#94a3b8", width: 0 }]);
  return f.wrap(inner);
}

export function barSvg({ width = 920, height = 300, title, subtitle, xLabels, groups, yFmt = (v) => Math.round(v) }) {
  const pad = { top: 52, right: 24, bottom: 40, left: 60 };
  const vals = groups.flatMap((g) => g.values).filter((v) => v != null);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(...vals);
  const span = (hi - lo) || 1;
  const f = frame({ width, height, title, subtitle, pad, yMin: lo - span * 0.08, yMax: hi + span * 0.12, yFmt, xLabels, zeroLine: lo < 0, xStep: 1 });
  const n = xLabels.length;
  const slot = f.w / n;
  const bw = Math.max(3, (slot * 0.78) / groups.length);
  let inner = "";
  groups.forEach((g, gi) => {
    g.values.forEach((v, i) => {
      if (v == null) return;
      const x = pad.left + i * slot + slot * 0.11 + gi * bw;
      const y0 = f.yAt(0);
      const y1 = f.yAt(v);
      inner += `<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(y1 - y0).toFixed(1)}" fill="${g.color}" opacity="${g.opacity ?? 0.9}"><title>${esc(xLabels[i])} ${esc(g.label)}: ${v.toFixed(1)}</title></rect>`;
    });
  });
  f.addLegend(groups);
  return f.wrap(inner);
}

export const rollingMean = (vals, win = 12) => vals.map((_, i) => {
  if (i + 1 < win) return null;
  const sl = vals.slice(i - win + 1, i + 1).filter((v) => v != null);
  return sl.length === win ? sl.reduce((a, b) => a + b, 0) / win : null;
});

export const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

export function corr(x, y) {
  const mx = mean(x), my = mean(y);
  let n = 0, a = 0, b = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); a += (x[i] - mx) ** 2; b += (y[i] - my) ** 2; }
  return n / Math.sqrt((a * b) || 1);
}
