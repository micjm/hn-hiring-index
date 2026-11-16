import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lineSvg, barSvg, scatterSvg, rollingMean, corr } from "./lib/svg.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const PLOTS_DIR = path.join(ROOT, "plots");

const WINDOWS = [
  { key: "21d", field: "comments_21d", hours: 21 * 24, accrualCorrect: false },
  { key: "24hr", field: "comments_24hr", hours: 24, accrualCorrect: true },
];

const KINDS = ["hiring", "wants_to_be_hired"];
const BASE_START = "2014-07";
const MA_ITERS = 5;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function addMonths(month, delta) {
  let [y, m] = month.split("-").map(Number);
  m += delta;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

function monthGrid(from, to) {
  const out = [];
  let m = from;
  while (m <= to) { out.push(m); m = addMonths(m, 1); }
  return out;
}

// Classic 2x12 centered moving average (0.5 weight on the two end points).
function ma2x12(vals) {
  return vals.map((_, t) => {
    if (t - 6 < 0 || t + 6 >= vals.length) return null;
    let sum = 0.5 * (vals[t - 6] ?? 0) + 0.5 * (vals[t + 6] ?? 0);
    let n = (vals[t - 6] != null ? 0.5 : 0) + (vals[t + 6] != null ? 0.5 : 0);
    for (let i = t - 5; i <= t + 5; i++) if (vals[i] != null) { sum += vals[i]; n += 1; }
    return n ? sum / n : null;
  });
}

// Iterative multiplicative seasonal adjustment (X-11-style, median-based, robust to outliers).
function seasonalAdjust(vals, months) {
  const moy = months.map((m) => Number(m.split("-")[1]) - 1);
  let sa = vals.slice();
  let factors = new Array(12).fill(1);
  let obs = [];
  for (let it = 0; it < MA_ITERS; it++) {
    const trend = ma2x12(sa);
    const buckets = Array.from({ length: 12 }, () => []);
    for (let t = 0; t < vals.length; t++) {
      if (vals[t] == null || trend[t] == null || !trend[t]) continue;
      buckets[moy[t]].push(vals[t] / trend[t]);
    }
    const raw = buckets.map((b) => (b.length >= 3 ? median(b) : (b.length ? mean(b) : 1)));
    const norm = mean(raw);
    factors = raw.map((f) => f / norm);
    obs = buckets.map((b) => b.length);
    sa = vals.map((v, t) => (v == null ? null : v / factors[moy[t]]));
  }
  return { sa, factors, obs };
}

// Trailing (causal) share of final total captured by the window, so 24hr counts can be
// restated as final-total-equivalents and used as a same-day nowcast.
function trailingShare(vals, win, minObs = 6) {
  return vals.map((_, t) => {
    const lo = Math.max(0, t - win + 1);
    const sl = vals.slice(lo, t + 1).filter((v) => v != null);
    if (sl.length >= minObs) return median(sl);
    const all = vals.slice(0, t + 1).filter((v) => v != null);
    return all.length ? median(all) : null;
  });
}

async function main() {
  const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, "posts.json"), "utf8"));
  const now = Date.now();

  const rows = raw.posts.map((p) => {
    const ageHours = (now - new Date(p.posted_at).getTime()) / 3_600_000;
    return {
      ...p,
      age_hours: Number(ageHours.toFixed(1)),
      windows_complete: WINDOWS.filter((w) => ageHours >= w.hours).map((w) => w.key),
    };
  });

  const mature = rows.filter((p) => p.windows_complete.includes("21d"));
  const partial = rows.filter((p) => !p.windows_complete.includes("21d"));

  const allMonths = monthGrid(
    mature.reduce((a, p) => (p.month < a ? p.month : a), "9999-12"),
    mature.reduce((a, p) => (p.month > a ? p.month : a), "0000-01"),
  );
  const overlapMonths = allMonths.filter((m) => m >= BASE_START);

  const series = {};
  for (const kind of KINDS) {
    const byMonth = new Map(mature.filter((p) => p.kind === kind).map((p) => [p.month, p]));
    series[kind] = { byMonth, months: allMonths };
    for (const w of WINDOWS) {
      const vals = allMonths.map((m) => byMonth.get(m)?.[w.field] ?? null);
      const totals = allMonths.map((m) => byMonth.get(m)?.comments ?? null);

      let level = vals;
      let share = null;
      if (w.accrualCorrect) {
        const sh = allMonths.map((m) => {
          const p = byMonth.get(m);
          return p && p.comments ? p[w.field] / p.comments : null;
        });
        share = trailingShare(sh, 12);
        level = vals.map((v, t) => (v == null || !share[t] ? null : v / share[t]));
      }

      const { sa, factors, obs } = seasonalAdjust(level, allMonths);
      series[kind][w.key] = { level, sa, factors, obs, share, raw: vals };
    }
  }

  // Rebase each deseasonalized series to 100 = mean of the common overlap period.
  const base = {};
  for (const w of WINDOWS) {
    for (const kind of KINDS) {
      const s = series[kind][w.key].sa;
      const vals = overlapMonths.map((m) => s[allMonths.indexOf(m)]).filter((v) => v != null);
      base[`${kind}:${w.key}`] = mean(vals);
    }
  }

  const index = overlapMonths.map((m) => {
    const t = allMonths.indexOf(m);
    const rec = { month: m };
    for (const w of WINDOWS) {
      const hSa = series.hiring[w.key].sa[t];
      const wSa = series.wants_to_be_hired[w.key].sa[t];
      if (hSa == null || wSa == null) continue;
      const hIdx = (100 * hSa) / base[`hiring:${w.key}`];
      const wIdx = (100 * wSa) / base[`wants_to_be_hired:${w.key}`];
      rec[`hiring_index_${w.key}`] = Number(hIdx.toFixed(2));
      rec[`wants_index_${w.key}`] = Number(wIdx.toFixed(2));
      // "Badness" is the headline representation: seekers relative to employer posts,
      // so higher = worse for job seekers. (Economists' "tightness" is the inverse of this.)
      rec[`badness_index_${w.key}`] = Number((100 * (wIdx / hIdx)).toFixed(2));
      rec[`tightness_index_${w.key}`] = rec[`badness_index_${w.key}`];
      rec[`activity_index_${w.key}`] = Number(Math.sqrt(hIdx * wIdx).toFixed(2));
      rec[`hiring_sa_${w.key}`] = Number(hSa.toFixed(1));
      rec[`wants_sa_${w.key}`] = Number(wSa.toFixed(1));
    }
    const hp = series.hiring.byMonth.get(m);
    const wp = series.wants_to_be_hired.byMonth.get(m);
    rec.hiring_raw_21d = hp?.comments_21d ?? null;
    rec.wants_raw_21d = wp?.comments_21d ?? null;
    rec.hiring_raw_24hr = hp?.comments_24hr ?? null;
    rec.wants_raw_24hr = wp?.comments_24hr ?? null;
    rec.hiring_official = hp?.official ?? null;
    rec.wants_official = wp?.official ?? null;
    return rec;
  }).filter((r) => r.badness_index_21d != null);

  // Empirical percentile + plain-language band for the badness representation.
  // 100 = average badness over the whole index period; 200 = twice as bad, 50 = half as bad.
  for (const w of WINDOWS) {
    const vals = index.map((r) => r[`badness_index_${w.key}`]).sort((a, b) => a - b);
    for (const r of index) {
      const v = r[`badness_index_${w.key}`];
      const rank = vals.filter((x) => x <= v).length;
      r[`badness_percentile_${w.key}`] = Number(((100 * rank) / vals.length).toFixed(1));
      r[`badness_band_${w.key}`] = v < 50 ? "good for seekers" : v < 100 ? "better than average" : v < 200 ? "worse than average" : v < 300 ? "bad" : "very bad";
      r[`seekers_per_employer_${w.key}`] = r[`hiring_raw_${w.key}`] ? Number((r[`wants_raw_${w.key}`] / r[`hiring_raw_${w.key}`]).toFixed(2)) : null;
    }
  }

  await fs.mkdir(PLOTS_DIR, { recursive: true });

  const seasonalFactors = {};
  for (const kind of KINDS) {
    for (const w of WINDOWS) {
      seasonalFactors[`${kind}_${w.key}`] = series[kind][w.key].factors.map((f) => Number(f.toFixed(4)));
    }
  }

  const accrualShare = {};
  for (const kind of KINDS) {
    accrualShare[`${kind}_24hr`] = series[kind]["24hr"].share.map((s) => (s == null ? null : Number(s.toFixed(4))));
  }

  const last = index.at(-1);
  const partialNote = partial.map((p) => ({
    month: p.month, kind: p.kind, id: p.id, age_hours: p.age_hours,
    comments: p.comments, comments_24hr: p.comments_24hr,
    windows_complete: p.windows_complete,
    note: p.windows_complete.includes("24hr")
      ? `Posted ${p.age_hours}h ago; the 24hr window is complete, but the 21d window is incomplete, so this month is excluded from the index until 21 days after posting.`
      : `Posted ${p.age_hours}h ago; even the 24hr window is incomplete, so this month is excluded from the index. The 24hr index becomes available 24h after posting, the 21d index after 21 days.`,
  }));

  const validation = {};
  for (const name of ["hiring_index", "wants_index", "badness_index", "tightness_index", "activity_index"]) {
    const a = index.map((r) => r[`${name}_21d`]);
    const b = index.map((r) => r[`${name}_24hr`]);
    const rel = a.map((v, i) => (100 * Math.abs(v - b[i])) / v).sort((x, y) => x - y);
    validation[name] = {
      corr_21d_vs_24hr: Number(corr(a, b).toFixed(4)),
      median_rel_diff_pct: Number(rel[Math.floor(rel.length / 2)].toFixed(2)),
      max_rel_diff_pct: Number(rel.at(-1).toFixed(2)),
    };
  }
  function moySpreadFromMonths(months, getter) {
    const v = months.map(getter);
    const tr = ma2x12(v);
    const b = Array.from({ length: 12 }, () => []);
    v.forEach((x, t) => { if (x != null && tr[t]) b[Number(months[t].split("-")[1]) - 1].push(x / tr[t]); });
    return b.map((x) => (x.length ? Math.abs(100 * (mean(x) - 1)) : 0));
  }
  const indexMonths = index.map((r) => r.month);
  const byMonthRow = new Map(index.map((r) => [r.month, r]));
  const byPost = new Map(rows.map((p) => [`${p.kind}|${p.month}`, p]));
  validation.seasonality_removed = {
    note: "Max month-of-year deviation from a centered 2x12 MA, in percent. Lower = less residual seasonality. Raw uses all mature months; adjusted uses the index overlap period.",
    hiring_raw_21d: Number(Math.max(...moySpreadFromMonths(allMonths, (m) => byPost.get(`hiring|${m}`)?.comments_21d ?? null)).toFixed(1)),
    hiring_adjusted_21d: Number(Math.max(...moySpreadFromMonths(indexMonths, (m) => byMonthRow.get(m).hiring_sa_21d)).toFixed(1)),
    wants_raw_21d: Number(Math.max(...moySpreadFromMonths(allMonths, (m) => byPost.get(`wants_to_be_hired|${m}`)?.comments_21d ?? null)).toFixed(1)),
    wants_adjusted_21d: Number(Math.max(...moySpreadFromMonths(indexMonths, (m) => byMonthRow.get(m).wants_sa_21d)).toFixed(1)),
  };
  validation.window_disagreement_notes = [
    "Largest 21d-vs-24hr gaps occur in low-volume months where the 24hr count is a small denominator (e.g. 2016-01 wants had 30 top-level comments in its first 24h) and in slow-start months (2024-09 hiring captured only 44% of its total in 24h vs 64% in August).",
    "These are window-measurement artifacts, not data errors: the 21d window is unaffected because it captures ~100% of final top-level comments.",
  ];

  const ERAS = [
    { label: "2014-16", from: "2014-01", to: "2016-12" },
    { label: "2017-19", from: "2017-01", to: "2019-12" },
    { label: "2020-22", from: "2020-01", to: "2022-12" },
    { label: "2023-24", from: "2023-01", to: "2024-12" },
    { label: "2025-26", from: "2025-01", to: "2026-12" },
  ];

  const facts = (() => {
    const avg = (rows, f) => (rows.length ? rows.reduce((s, r) => s + r[f], 0) / rows.length : null);
    const round = (v, d = 0) => (v == null ? null : Number(v.toFixed(d)));
    const eras = ERAS.map((e) => {
      const rows = index.filter((r) => r.month >= e.from && r.month <= e.to);
      return {
        label: e.label, months: rows.length,
        badness_21d: round(avg(rows, "badness_index_21d")),
        badness_24hr: round(avg(rows, "badness_index_24hr")),
        hiring_index_21d: round(avg(rows, "hiring_index_21d")),
        wants_index_21d: round(avg(rows, "wants_index_21d")),
      };
    });
    const worst = [...index].sort((a, b) => b.badness_index_21d - a.badness_index_21d).slice(0, 8)
      .map((r) => ({ month: r.month, badness_21d: r.badness_index_21d, badness_24hr: r.badness_index_24hr, hiring_raw_21d: r.hiring_raw_21d, wants_raw_21d: r.wants_raw_21d, seekers_per_employer_21d: r.seekers_per_employer_21d }));
    const best = [...index].sort((a, b) => a.badness_index_21d - b.badness_index_21d).slice(0, 8)
      .map((r) => ({ month: r.month, badness_21d: r.badness_index_21d, badness_24hr: r.badness_index_24hr, hiring_raw_21d: r.hiring_raw_21d, wants_raw_21d: r.wants_raw_21d, seekers_per_employer_21d: r.seekers_per_employer_21d }));
    const bestMonth = best[0];
    const trailing12 = index.slice(-12);
    return {
      definition: "Badness = 100 x (seasonally adjusted 'who wants to be hired' volume) / (seasonally adjusted 'who is hiring' volume). 100 = average over the index period; higher = worse for job seekers.",
      latest: {
        month: last.month, badness_21d: last.badness_index_21d, badness_24hr: last.badness_index_24hr,
        percentile: last.badness_percentile_21d, band: last.badness_band_21d,
        hiring_index_21d: last.hiring_index_21d, wants_index_21d: last.wants_index_21d,
        hiring_raw_21d: last.hiring_raw_21d, wants_raw_21d: last.wants_raw_21d,
        seekers_per_employer_21d: last.seekers_per_employer_21d,
        multiple_of_best_month: round(last.badness_index_21d / index.find((r) => r.month === bestMonth.month).badness_index_21d, 1),
      },
      trailing_12m_mean_badness_21d: round(avg(trailing12, "badness_index_21d")),
      trailing_12m_mean_badness_24hr: round(avg(trailing12, "badness_index_24hr")),
      eras, worst_months: worst, best_months: best,
      window_agreement: {
        corr_badness_21d_vs_24hr: validation.badness_index.corr_21d_vs_24hr,
        median_rel_diff_pct: validation.badness_index.median_rel_diff_pct,
      },
      reading_examples: [
        `Best month on record: ${bestMonth.month} at ${bestMonth.badness_21d} (${bestMonth.wants_raw_21d} seeker vs ${bestMonth.hiring_raw_21d} hiring top-level comments in 21d).`,
        `Latest month: ${last.month} at ${last.badness_index_21d} (${last.wants_raw_21d} seeker vs ${last.hiring_raw_21d} hiring top-level comments in 21d) — ${round(last.badness_index_21d / index.find((r) => r.month === bestMonth.month).badness_index_21d, 1)}x the best month.`,
        `100 means exactly as bad as the ${index[0].month}..${last.month} average; 200 means twice as bad; 50 means half as bad.`,
      ],
    };
  })();

  const output = {
    generated_at: new Date().toISOString(),
    method: {
      comment_scope: "Top-level comments only (parent_id === story_id); nested replies under listings are excluded.",
      deseasonalization: `Iterative multiplicative seasonal adjustment (${MA_ITERS} passes): 2x12 centered MA trend -> median month-of-year ratio -> factors normalized to mean 1.0 -> series / factors. Estimated per (kind x window) independently.`,
      window_correction: "24hr counts are divided by a trailing 12-month median share of the final total, restating them as final-total-equivalents so the 24hr and 21d indexes share a common scale and the 24hr index can nowcast a thread on its first day.",
      rebasing: "Each deseasonalized series is rebased to 100 = mean over the common overlap period 2014-07 onward.",
      indexes: {
        badness_index: "HEADLINE. 100 * wants_index / hiring_index, i.e. seasonally adjusted job-seeker volume relative to employer-post volume. 100 = average badness over 2014-07..latest; 200 = twice as bad as average, 50 = half as bad. Higher = worse for job seekers. Scale-free: HN audience growth cancels out.",
        badness_percentile: "Empirical percentile of this month's badness within the whole index period (100 = worst month on record).",
        badness_band: "good for seekers (<50), better than average (50-100), worse than average (100-200), bad (200-300), very bad (>=300).",
        hiring_index: "Deseasonalized employer-post volume (demand). Its level is partly contaminated by HN audience growth.",
        wants_index: "Deseasonalized job-seeker volume (supply). Its level is partly contaminated by HN audience growth.",
        tightness_index: "Deprecated alias of badness_index, kept for backward compatibility. Note it is the inverse of the economist's usual 'tightness' (vacancies per unemployed).",
        activity_index: "sqrt(hiring_index * wants_index). Overall job-thread engagement; NOT scale-free, so it partly tracks HN's own traffic.",
      },
      window_choice: "21d captures 99.9-100% of final top-level comments with no next-month overlap (r=1.000 with total) and is the recommended basis. 24hr is the fast nowcast (r=0.986 with 21d).",
      excluded: "Months with no complete 21d window are excluded (see partial_months).",
    },
    base_period: { start: BASE_START, end: index.at(-1).month, months: index.length },
    seasonal_factors: { months: MONTH_NAMES, ...seasonalFactors },
    accrual_share_24hr: { months: allMonths, ...accrualShare },
    all_months: allMonths,
    index,
    facts,
    validation,
    partial_months: partialNote,
    latest: {
      month: last.month,
      badness_21d: last.badness_index_21d,
      badness_24hr: last.badness_index_24hr,
      badness_percentile_21d: last.badness_percentile_21d,
      badness_band_21d: last.badness_band_21d,
      seekers_per_employer_21d: last.seekers_per_employer_21d,
      tightness_21d: last.tightness_index_21d,
      tightness_24hr: last.tightness_index_24hr,
      hiring_index_21d: last.hiring_index_21d,
      wants_index_21d: last.wants_index_21d,
      activity_index_21d: last.activity_index_21d,
    },
  };

  await fs.writeFile(path.join(DATA_DIR, "index.json"), JSON.stringify(output, null, 2) + "\n");

  const cols = [
    "month",
    "badness_index_21d", "badness_index_24hr", "badness_percentile_21d", "badness_band_21d", "seekers_per_employer_21d",
    "hiring_raw_21d", "wants_raw_21d", "hiring_raw_24hr", "wants_raw_24hr",
    "hiring_sa_21d", "wants_sa_21d", "hiring_sa_24hr", "wants_sa_24hr",
    "hiring_index_21d", "wants_index_21d", "tightness_index_21d", "activity_index_21d",
    "hiring_index_24hr", "wants_index_24hr", "tightness_index_24hr", "activity_index_24hr",
  ];
  const csv = [cols.join(","), ...index.map((r) => cols.map((c) => (r[c] ?? "")).join(","))].join("\n") + "\n";
  await fs.writeFile(path.join(DATA_DIR, "index.csv"), csv);

  const xLabels = index.map((r) => r.month);
  const bad21 = index.map((r) => r.badness_index_21d);
  const bad24 = index.map((r) => r.badness_index_24hr);
  const tight21 = bad21;
  const tight24 = bad24;


  const bandIdx = (from, to) => ({ from: Math.max(0, index.findIndex((r) => r.month >= from)), to: (() => { const i = index.findIndex((r) => r.month > to); return i < 0 ? index.length - 1 : i; })(), label: "pandemic" });
  const PANDEMIC = [bandIdx("2020-03", "2023-05")];
  const blogX = index.map((r, i) => (i === 0 || (r.month.endsWith("-01") && Number(r.month.slice(0, 4)) % 2 === 0)) ? r.month.slice(0, 4) : "");
  await fs.writeFile(path.join(PLOTS_DIR, "05-index-deseasonalized.svg"), lineSvg({
    title: "5. Job seekers vs employer posts (seasonally adjusted, monthly)",
    subtitle: `100 = mean of ${index[0].month}..${last.month} for each series. Badness = seekers / employer posts`,
    width: 680, height: 300,
    xLabels: blogX,
    xStep: 1,
    bands: PANDEMIC,
    yMax: 300,
    series: [
      { label: "Seekers index (wants to be hired)", values: index.map((r) => r.wants_index_21d), color: "#dc2626", width: 2.4 },
      { label: "Employer-post index (who is hiring)", values: index.map((r) => r.hiring_index_21d), color: "#2563eb", width: 2.4 },
    ],
  }));

  await fs.writeFile(path.join(PLOTS_DIR, "06-badness-index.svg"), lineSvg({
    title: "6. HN Job Market Badness Index = 100 x wants_index / hiring_index",
    subtitle: `Higher = worse for job seekers. 100 = ${index[0].month}..${last.month} average. Monthly values, no smoothing`,
    width: 680, height: 330,
    xLabels: blogX,
    xStep: 1,
    bands: PANDEMIC,
    yMax: Math.max(560, Math.ceil((Math.max(...bad21) * 1.08) / 50) * 50),
    yMin: 0,
    series: [
      { label: "Badness (monthly)", values: bad21, color: "#dc2626", width: 2.4 },
      { label: "Average badness (100)", values: xLabels.map(() => 100), color: "#94a3b8", width: 1.2, dash: "3 3" },
    ],
  }));

  const eraAvg = (field) => ERAS.map((e) => {
    const rows = index.filter((r) => r.month >= e.from && r.month <= e.to);
    return rows.length ? Number((rows.reduce((s, r) => s + r[field], 0) / rows.length).toFixed(1)) : null;
  });
  await fs.writeFile(path.join(PLOTS_DIR, "09-badness-eras.svg"), barSvg({
    title: "9. Average Badness by Era (both windows agree)",
    subtitle: "100 = whole-period average. 2017-19 was the best era for seekers; 2025-26 is more than 5x worse",
    xLabels: ERAS.map((e) => e.label),
    yFmt: (v) => `${Math.round(v)}`,
    groups: [
      { label: "Badness 21d", values: eraAvg("badness_index_21d"), color: "#dc2626" },
      { label: "Badness 24hr", values: eraAvg("badness_index_24hr"), color: "#fdba74" },
    ],
  }));

  await fs.writeFile(path.join(PLOTS_DIR, "07-seasonal-factors.svg"), barSvg({
    title: "7. Estimated Seasonal Factors (% of annual mean, 100 = neutral)",
    subtitle: "Estimated independently per series x window; Jan holiday and Dec dip are the dominant effects",
    xLabels: MONTH_NAMES,
    yFmt: (v) => `${Math.round(v)}`,
    groups: [
      { label: "hiring 21d", values: seasonalFactors.hiring_21d.map((v) => v * 100), color: "#1d4ed8" },
      { label: "hiring 24hr", values: seasonalFactors.hiring_24hr.map((v) => v * 100), color: "#93c5fd" },
      { label: "wants 21d", values: seasonalFactors.wants_to_be_hired_21d.map((v) => v * 100), color: "#dc2626" },
      { label: "wants 24hr", values: seasonalFactors.wants_to_be_hired_24hr.map((v) => v * 100), color: "#fca5a5" },
    ],
  }));

  const pts = index.map((r) => ({ x: r.badness_index_21d, y: r.badness_index_24hr, label: r.month, color: r.month >= "2023-01" ? "#dc2626" : r.month >= "2019-01" ? "#2563eb" : "#94a3b8", r: r.month >= "2023-01" ? 3.6 : 2.8 }));
  const mx = Math.max(...pts.map((p) => p.x)) * 1.06;
  await fs.writeFile(path.join(PLOTS_DIR, "08-window-agreement.svg"), scatterSvg({
    title: "8. Window Cross-Validation: 21d vs 24hr Badness",
    subtitle: `r = ${corr(pts.map((p) => p.x), pts.map((p) => p.y)).toFixed(3)} on the identity line; grey <2019, blue 2019-22, red 2023+`,
    points: pts,
    xMax: mx,
    yMax: Math.max(...pts.map((p) => p.y)) * 1.06,
    xLabel: "badness_index_21d (basis of record)",
    yLabel: "badness_index_24hr (fast nowcast)",
  }));

  console.log(`Index built: ${index.length} months (${index[0].month} -> ${last.month})`);
  console.log(`Excluded (incomplete windows): ${partialNote.map((p) => `${p.month} ${p.kind} @${p.age_hours}h`).join(", ") || "none"}`);
  console.log("\nSeasonal factors (100 = annual mean):");
  console.log("month      " + MONTH_NAMES.map((m) => m.padStart(6)).join(""));
  for (const [k, f] of Object.entries(seasonalFactors)) {
    console.log(k.padEnd(24) + f.map((v) => (v * 100).toFixed(0).padStart(6)).join(""));
  }
  console.log("\nLatest complete month:", last.month);
  for (const w of WINDOWS) {
    console.log(`  [${w.key}] hiring_index=${last[`hiring_index_${w.key}`]}  wants_index=${last[`wants_index_${w.key}`]}  badness=${last[`badness_index_${w.key}`]} (percentile ${last[`badness_percentile_${w.key}`]}, ${last[`badness_band_${w.key}`]})  activity=${last[`activity_index_${w.key}`]}`);
  }
  const sortedByBad = [...index].sort((a, b) => b.badness_index_21d - a.badness_index_21d);
  console.log("\nWorst months for seekers (badness 21d):");
  for (const r of sortedByBad.slice(0, 5)) console.log(`  ${r.month}  badness=${r.badness_index_21d}  hiring=${r.hiring_raw_21d}  wants=${r.wants_raw_21d}`);
  console.log("Best months for seekers:");
  for (const r of sortedByBad.slice(-5).reverse()) console.log(`  ${r.month}  badness=${r.badness_index_21d}  hiring=${r.hiring_raw_21d}  wants=${r.wants_raw_21d}`);

  console.log("\nValidation - 21d vs 24hr agreement:");
  for (const [k, v] of Object.entries(validation)) {
    if (k === "seasonality_removed" || k === "window_disagreement_notes") continue;
    console.log(`  ${k.padEnd(16)} corr=${v.corr_21d_vs_24hr}  median|rel diff|=${v.median_rel_diff_pct}%  max=${v.max_rel_diff_pct}%`);
  }
  const sr = validation.seasonality_removed;
  console.log("\nValidation - residual seasonality (max month-of-year deviation, lower is better):");
  console.log(`  hiring: raw ${sr.hiring_raw_21d}% -> adjusted ${sr.hiring_adjusted_21d}%`);
  console.log(`  wants:  raw ${sr.wants_raw_21d}% -> adjusted ${sr.wants_adjusted_21d}%`);
  console.log("\nWrote data/index.json (incl. facts), data/index.csv and plots/05,06,07,08,09*.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
