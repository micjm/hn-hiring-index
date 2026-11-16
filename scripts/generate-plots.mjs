import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lineSvg, barSvg, scatterSvg, rollingMean, mean, corr } from "./lib/svg.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const PLOTS_DIR = path.join(ROOT, "plots");

async function main() {
  const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, "posts.json"), "utf8"));
  // A post is mature once its full 21-day comment window has elapsed. Deriving
  // this from posted_at (rather than a hardcoded month) lets scheduled rebuilds
  // pick up each new month automatically.
  const now = Date.now();
  const WINDOW_MS = 21 * 24 * 3600 * 1000;
  const isMature = (p) => now - new Date(p.posted_at).getTime() >= WINDOW_MS;
  const mature = raw.posts.filter(isMature);
  const censoredMonths = [...new Set(raw.posts.filter((p) => !isMature(p)).map((p) => p.month))].sort();
  const byKind = { hiring: new Map(), wants_to_be_hired: new Map(), freelancer: new Map() };
  for (const p of mature) byKind[p.kind]?.set(p.month, p);

  const months = [...new Set(mature.map((p) => p.month))].sort();
  const h21 = months.map((m) => byKind.hiring.get(m)?.comments_21d ?? null);
  const w21 = months.map((m) => byKind.wants_to_be_hired.get(m)?.comments_21d ?? null);
  const f21 = months.map((m) => byKind.freelancer.get(m)?.comments_21d ?? null);

  await fs.mkdir(PLOTS_DIR, { recursive: true });

  const svg1 = lineSvg({
    title: "1. Monthly Top-Level Comment Volume (21-day window) & 12-Month Rolling Mean",
    subtitle: `${months[0]} to ${months.at(-1)}`,
    xLabels: months,
    yMax: 1100,
    series: [
      { label: "Hiring (21d)", values: h21, color: "#93c5fd", width: 1.3 },
      { label: "Hiring (12m MA)", values: rollingMean(h21.map((v) => v ?? 0), 12), color: "#1d4ed8", width: 2.5 },
      { label: "Wants to be hired (21d)", values: w21, color: "#fca5a5", width: 1.3 },
      { label: "Wants (12m MA)", values: w21.map((_, i) => (i >= 60 ? mean(w21.slice(i - 11, i + 1).filter((x) => x != null)) : null)), color: "#dc2626", width: 2.5 },
      { label: "Freelancer (21d)", values: f21, color: "#6ee7b7", width: 1.3 },
    ],
  });
  await fs.writeFile(path.join(PLOTS_DIR, "01-series-overview.svg"), svg1);

  const hShare24 = months.map((m) => {
    const p = byKind.hiring.get(m);
    return p ? (100 * p.comments_24hr) / p.comments : null;
  });
  const hShare7 = months.map((m) => {
    const p = byKind.hiring.get(m);
    return p ? (100 * p.comments_7d) / p.comments : null;
  });
  const hShare21 = months.map((m) => {
    const p = byKind.hiring.get(m);
    return p ? (100 * p.comments_21d) / p.comments : null;
  });
  const svg2 = lineSvg({
    title: "2. Comment Accrual Share of Final Total (Who is hiring?)",
    subtitle: "24hr drifts down from ~82% to ~61%; 7d (~93%) and 21d (99.9%) stay stable",
    xLabels: months,
    yMin: 35,
    yMax: 105,
    yFmt: (v) => `${Math.round(v)}%`,
    series: [
      { label: "21d / total", values: hShare21, color: "#0f766e", width: 2 },
      { label: "7d / total", values: hShare7, color: "#2563eb", width: 1.8 },
      { label: "24hr / total (raw)", values: hShare24, color: "#fdba74", width: 1.2 },
      { label: "24hr / total (12m MA)", values: rollingMean(hShare24, 12), color: "#ea580c", width: 2.5 },
    ],
  });
  await fs.writeFile(path.join(PLOTS_DIR, "02-window-accrual.svg"), svg2);

  const commonMonths = months.filter((m) => byKind.hiring.has(m) && byKind.wants_to_be_hired.has(m));
  const ratio = commonMonths.map((m) => byKind.wants_to_be_hired.get(m).comments_21d / byKind.hiring.get(m).comments_21d);
  const hYoY = commonMonths.map((m, i) => (i < 12 ? null : (100 * (byKind.hiring.get(m).comments_21d - byKind.hiring.get(commonMonths[i - 12]).comments_21d)) / byKind.hiring.get(commonMonths[i - 12]).comments_21d));
  const wYoY = commonMonths.map((m, i) => (i < 12 ? null : (100 * (byKind.wants_to_be_hired.get(m).comments_21d - byKind.wants_to_be_hired.get(commonMonths[i - 12]).comments_21d)) / byKind.wants_to_be_hired.get(commonMonths[i - 12]).comments_21d));

  const svg3 = lineSvg({
    title: "3. YoY % Change: Hiring vs Wants to be Hired (21-day window)",
    subtitle: "Strong inverse cycle (COVID 2020 spike in seekers, 2021 hiring boom, 2022-24 seeker surge)",
    xLabels: commonMonths,
    yMin: -60,
    yMax: 180,
    zeroLine: true,
    yFmt: (v) => `${Math.round(v)}%`,
    series: [
      { label: "Hiring YoY %", values: hYoY, color: "#1d4ed8", width: 2.2 },
      { label: "Wants to be Hired YoY %", values: wYoY, color: "#dc2626", width: 2.2 },
      { label: "Wants / Hiring ratio (x100%)", values: ratio.map((r) => r * 100), color: "#7c3aed", width: 1.8, dash: "4 3" },
    ],
  });
  await fs.writeFile(path.join(PLOTS_DIR, "03-yoy-and-ratio.svg"), svg3);

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function seasonality(kind, field) {
    const arr = [...byKind[kind].entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const vals = arr.map(([, p]) => p[field]);
    const buckets = Array.from({ length: 12 }, () => []);
    for (let i = 6; i < arr.length - 6; i++) {
      const ma = mean(vals.slice(i - 6, i + 6));
      const moy = Number(arr[i][0].split("-")[1]) - 1;
      buckets[moy].push((vals[i] / ma - 1) * 100);
    }
    return buckets.map((b) => Number(mean(b).toFixed(2)));
  }

  const seasHiring24 = seasonality("hiring", "comments_24hr");
  const seasHiring21 = seasonality("hiring", "comments_21d");
  const seasWants21 = seasonality("wants_to_be_hired", "comments_21d");

  const svg4 = lineSvg({
    title: "4. Seasonality Profile (% deviation from centered 12-month MA)",
    subtitle: `Jan 1 holiday hits 24hr (${seasHiring24[0]}%) harder than 21d (${seasHiring21[0]}%); Dec dips in both series`,
    xLabels: monthNames,
    yMin: -32,
    yMax: 20,
    zeroLine: true,
    yFmt: (v) => `${Math.round(v)}%`,
    series: [
      { label: "Hiring (21d)", values: seasHiring21, color: "#1d4ed8", width: 2.4 },
      { label: "Hiring (24hr)", values: seasHiring24, color: "#f97316", width: 2, dash: "4 3" },
      { label: "Wants to be Hired (21d)", values: seasWants21, color: "#dc2626", width: 2.4 },
    ],
  });
  await fs.writeFile(path.join(PLOTS_DIR, "04-seasonality.svg"), svg4);

  const lags = [];
  const hY = hYoY.slice(12);
  const wY = wYoY.slice(12);
  const hL = commonMonths.map((m) => byKind.hiring.get(m).comments_21d);
  const wL = commonMonths.map((m) => byKind.wants_to_be_hired.get(m).comments_21d);
  for (let lag = -6; lag <= 6; lag++) {
    const slicePair = (a, b) => (lag > 0 ? [a.slice(0, -lag), b.slice(lag)] : lag < 0 ? [a.slice(-lag), b.slice(0, lag)] : [a, b]);
    const [la, lb] = slicePair(hL, wL);
    const [ya, yb] = slicePair(hY, wY);
    lags.push({ lag, corr_levels: Number(corr(la, lb).toFixed(3)), corr_yoy: Number(corr(ya, yb).toFixed(3)) });
  }

  const analysis = {
    generated_at: new Date().toISOString(),
    mature_through: months.at(-1),
    censored_months: censoredMonths,
    seasonality: { months: monthNames, hiring_24hr: seasHiring24, hiring_21d: seasHiring21, wants_21d: seasWants21 },
    lead_lag: lags,
  };
  await fs.writeFile(path.join(DATA_DIR, "analysis.json"), JSON.stringify(analysis, null, 2) + "\n");
  console.log("Generated 4 SVG plots in plots/ and data/analysis.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
