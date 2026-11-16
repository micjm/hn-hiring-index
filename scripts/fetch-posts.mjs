import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://hacker-news.firebaseio.com/v0";
const ALGOLIA_API = "https://hn.algolia.com/api/v1";
const OFFICIAL_ACCOUNTS = ["whoishiring", "_whoishiring"];
const CONCURRENCY = 25;
const ALGOLIA_CONCURRENCY = 6;
const ALGOLIA_BATCH_MAX_POSTS = 6;
const ALGOLIA_BATCH_MAX_COMMENTS = 800;

const WINDOWS = [
  { field: "comments_24hr", seconds: 24 * 3600 },
  { field: "comments_7d", seconds: 7 * 86400 },
  { field: "comments_21d", seconds: 21 * 86400 },
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const SEED_FILE = path.join(DATA_DIR, "seed-extra.json");
const OUT_JSON = path.join(DATA_DIR, "posts.json");
const OUT_CSV = path.join(DATA_DIR, "posts.csv");

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const KINDS = [
  { kind: "hiring", re: /who is hiring\?/i },
  { kind: "wants_to_be_hired", re: /who wants to be hired\?/i },
  { kind: "freelancer", re: /freelancer\?\s*seeking freelancers?\?/i },
];

async function getJson(url, attempt = 1) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 6) throw new Error(`${url}: ${err.message}`);
    await new Promise((r) => setTimeout(r, 1200 * attempt));
    return getJson(url, attempt + 1);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

const fetchItem = (id) => getJson(`${API}/item/${id}.json`);
const fetchUser = (name) => getJson(`${API}/user/${name}.json`);

async function fetchTopLevelComments(storyIds) {
  const tagGroup = storyIds.length === 1 ? `story_${storyIds[0]}` : `(${storyIds.map((id) => `story_${id}`).join(",")})`;
  const parentGroup = storyIds.length === 1 ? `parent_id=${storyIds[0]}` : `(${storyIds.map((id) => `parent_id=${id}`).join(",")})`;
  const storySet = new Set(storyIds.map(Number));
  const seen = new Set();
  const hits = [];
  let maxCreatedAt = null;

  while (true) {
    const numFilter = maxCreatedAt == null ? parentGroup : `${parentGroup},created_at_i<=${maxCreatedAt}`;
    const url = `${ALGOLIA_API}/search_by_date?tags=comment,${tagGroup}&numericFilters=${encodeURIComponent(numFilter)}&hitsPerPage=1000`;
    const res = await getJson(url);
    const batch = res.hits ?? [];
    let added = 0;
    let minTs = Infinity;
    for (const h of batch) {
      const id = String(h.objectID);
      const ts = Number(h.created_at_i);
      if (ts < minTs) minTs = ts;
      if (seen.has(id)) continue;
      seen.add(id);
      const storyId = Number(h.story_id);
      const parentId = Number(h.parent_id);
      if (storySet.has(storyId) && parentId === storyId) {
        hits.push({ story_id: storyId, parent_id: parentId, created_at_i: ts });
        added++;
      }
    }
    if (batch.length < 1000 || seen.size >= (res.nbHits ?? 0) || !added || !Number.isFinite(minTs)) break;
    maxCreatedAt = maxCreatedAt != null && minTs === maxCreatedAt ? minTs - 1 : minTs;
  }
  return hits;
}

async function enrichWindows(posts, existingById, isTopLevel) {
  const nowSec = Math.floor(Date.now() / 1000);
  const forceRefresh = process.argv.includes("--refresh") || !isTopLevel;
  const toFetch = [];
  for (const post of posts) {
    const t0 = Math.floor(new Date(post.posted_at).getTime() / 1000);
    const prev = existingById.get(post.id);
    const mature = nowSec - t0 > 30 * 86400;
    if (
      !forceRefresh &&
      mature &&
      prev &&
      typeof prev.comments === "number" &&
      WINDOWS.every(({ field }) => typeof prev[field] === "number")
    ) {
      post.comments = prev.comments;
      for (const { field } of WINDOWS) post[field] = prev[field];
    } else {
      toFetch.push(post);
    }
  }
  const batches = [];
  let cur = [];
  let curCount = 0;
  for (const post of toFetch) {
    const est = post.comments || 500;
    if (cur.length && (cur.length >= ALGOLIA_BATCH_MAX_POSTS || curCount + est > ALGOLIA_BATCH_MAX_COMMENTS)) {
      batches.push(cur);
      cur = [];
      curCount = 0;
    }
    cur.push(post);
    curCount += est;
  }
  if (cur.length) batches.push(cur);

  if (batches.length) {
    console.log(`Fetching Algolia top-level comment counts (${WINDOWS.map((w) => w.field).join(", ")}) across ${batches.length} batches...`);
    await mapLimit(batches, ALGOLIA_CONCURRENCY, async (group) => {
      const hits = await fetchTopLevelComments(group.map((p) => p.id));
      for (const post of group) {
        const t0 = Math.floor(new Date(post.posted_at).getTime() / 1000);
        const storyHits = hits.filter((h) => h.story_id === post.id && h.parent_id === post.id);
        post.comments = storyHits.length;
        for (const { field, seconds } of WINDOWS) {
          post[field] = storyHits.filter((h) => h.created_at_i <= t0 + seconds).length;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    });
  }
}

function classify(title) {
  for (const { kind, re } of KINDS) if (re.test(title)) return kind;
  return null;
}

function parseMonth(title) {
  const m = title.match(/\(\s*([A-Za-z]+),?\s*(\d{4})\s*\)/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return `${m[2]}-${String(mon).padStart(2, "0")}`;
}

function toRecord(item, { kind, month, official, note }) {
  return {
    id: item.id,
    kind,
    month,
    title: item.title.trim(),
    by: item.by,
    posted_at: new Date(item.time * 1000).toISOString(),
    score: item.score ?? 0,
    comments: item.kids?.length ?? 0,
    official,
    url: `https://news.ycombinator.com/item?id=${item.id}`,
    ...(note ? { note } : {}),
  };
}

function monthRange(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function toCsv(rows) {
  const cols = [
    "month", "kind", "id",
    "comments", "comments_24hr", "comments_7d", "comments_21d",
    "score", "by", "posted_at", "official", "title", "url",
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

async function loadExisting() {
  try {
    const raw = JSON.parse(await fs.readFile(OUT_JSON, "utf8"));
    return {
      isTopLevel: raw.comment_scope === "top_level",
      byId: new Map((raw.posts ?? []).map((p) => [p.id, p])),
    };
  } catch {
    return { isTopLevel: false, byId: new Map() };
  }
}

async function main() {
  const { isTopLevel, byId: existingById } = await loadExisting();
  const enrichOnly = process.argv.includes("--enrich-only") && existingById.size > 0;
  const skipped = [];
  let posts;

  if (enrichOnly) {
    posts = [...existingById.values()];
  } else {
    const candidates = [];
    for (const account of OFFICIAL_ACCOUNTS) {
      const user = await fetchUser(account);
      const ids = user?.submitted ?? [];
      console.log(`${account}: ${ids.length} submissions`);
      const items = await mapLimit(ids, CONCURRENCY, fetchItem);
      for (const item of items) {
        if (!item || item.type !== "story" || item.deleted || item.dead || !item.title) continue;
        const kind = classify(item.title);
        if (!kind) continue;
        const month = parseMonth(item.title);
        if (!month) { skipped.push(`${item.id} (no month in title): ${item.title}`); continue; }
        candidates.push(toRecord(item, { kind, month, official: true }));
      }
    }

    const seed = JSON.parse(await fs.readFile(SEED_FILE, "utf8")).posts;
    const seedItems = await mapLimit(seed, CONCURRENCY, (s) => fetchItem(s.id));
    seed.forEach((s, i) => {
      const item = seedItems[i];
      if (!item || item.deleted || item.dead) { skipped.push(`${s.id} (seed unavailable)`); return; }
      candidates.push(toRecord(item, { kind: s.kind, month: s.month, official: false, note: s.note }));
    });

    const byKey = new Map();
    for (const rec of candidates) {
      const key = `${rec.kind}:${rec.month}`;
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, rec); continue; }
      const better = rec.comments > prev.comments ? rec : prev;
      const worse = better === rec ? prev : rec;
      skipped.push(`${worse.id} (duplicate for ${key}, kept ${better.id}): ${worse.title}`);
      byKey.set(key, better);
    }

    posts = [...byKey.values()].sort((a, b) => a.month.localeCompare(b.month) || a.kind.localeCompare(b.kind));
  }

  await enrichWindows(posts, existingById, isTopLevel);
  posts = posts.map(({ id, kind, month, title, by, posted_at, score, comments, comments_24hr, comments_7d, comments_21d, official, url, note }) => ({
    id, kind, month, title, by, posted_at, score,
    comments, comments_24hr, comments_7d, comments_21d,
    official, url, ...(note ? { note } : {}),
  }));

  await fs.mkdir(DATA_DIR, { recursive: true });
  const output = {
    generated_at: new Date().toISOString(),
    comment_scope: "top_level",
    sources: { official_accounts: OFFICIAL_ACCOUNTS, extra: path.basename(SEED_FILE) },
    posts,
  };
  await fs.writeFile(OUT_JSON, JSON.stringify(output, null, 2) + "\n");
  await fs.writeFile(OUT_CSV, toCsv(posts));

  console.log(`\nWrote ${posts.length} posts to ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_CSV)}`);
  for (const { kind } of KINDS) {
    const months = posts.filter((p) => p.kind === kind).map((p) => p.month);
    const have = new Set(months);
    const missing = monthRange(months[0], months.at(-1)).filter((m) => !have.has(m));
    console.log(`  ${kind.padEnd(18)} ${months.length} months, ${months[0]} -> ${months.at(-1)}${missing.length ? `, missing: ${missing.join(", ")}` : ""}`);
  }
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  ${s}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
