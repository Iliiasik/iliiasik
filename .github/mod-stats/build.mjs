import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATS_PATH = path.join(DIR, "stats.json");
const CARD_PATH = path.join(DIR, "card.svg");
const config = JSON.parse(await readFile(path.join(DIR, "config.json"), "utf8"));

const W = 840;
const P = 28;
const FONT = "'Segoe UI', -apple-system, BlinkMacSystemFont, Ubuntu, 'Helvetica Neue', Arial, sans-serif";

const T = {
  base: "#0d1117",
  border: "rgba(255,255,255,0.14)",
  text: "#ffffff",
  muted: "rgba(255,255,255,0.72)",
  track: "rgba(255,255,255,0.16)",
  tile: "rgba(255,255,255,0.12)",
  modrinth: "#1bd96a",
  curseforge: "#f16436",
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function download(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return {
      type: res.headers.get("content-type")?.split(";")[0] || "image/png",
      buf: Buffer.from(await res.arrayBuffer()),
    };
  } catch (err) {
    console.error(`image fail ${url}: ${err.message}`);
    return null;
  }
}

const dataUri = (img) => (img ? `data:${img.type};base64,${img.buf.toString("base64")}` : null);

async function iconUri(url) {
  const img = await download(url);
  if (!img || img.buf.length > (config.maxIconKB ?? 1024) * 1024) return null;
  return dataUri(img);
}

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

async function shrinkAnimation(img, width) {
  if (!hasFfmpeg()) return img;
  const dir = await mkdtemp(path.join(tmpdir(), "mod-stats-"));
  try {
    const input = path.join(dir, "in");
    const output = path.join(dir, "out.webp");
    await writeFile(input, img.buf);
    for (const codec of ["libwebp_anim", "libwebp"]) {
      const run = spawnSync("ffmpeg", [
        "-y", "-loglevel", "error", "-i", input,
        "-vf", `scale='min(${width},iw)':-2:flags=lanczos`,
        "-c:v", codec, "-quality", String(config.background?.quality ?? 70),
        "-loop", "0", "-an", output,
      ], { timeout: 120_000, stdio: "ignore" });
      if (run.status !== 0) continue;
      const buf = await readFile(output);
      if (buf.length && buf.length < img.buf.length) return { type: "image/webp", buf };
      return img;
    }
    return img;
  } catch {
    return img;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadBackground() {
  const bg = config.background;
  if (!bg) return null;
  const cachePath = path.join(DIR, bg.cache ?? "background.webp");
  try {
    const buf = await readFile(cachePath);
    console.log(`background from cache ${path.basename(cachePath)}, ${Math.round(buf.length / 1024)}KB`);
    return dataUri({ type: "image/webp", buf });
  } catch {}
  const img = await download(bg.url);
  if (!img) return null;
  console.log(`background downloaded, ${Math.round(img.buf.length / 1024)}KB, converting`);
  const small = await shrinkAnimation(img, bg.width ?? W);
  console.log(`background ${Math.round(img.buf.length / 1024)}KB -> ${Math.round(small.buf.length / 1024)}KB`);
  if (small.type === "image/webp") await writeFile(cachePath, small.buf);
  return dataUri(small);
}

function fmt(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const truncate = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);

async function fetchModrinth(user) {
  const headers = { "User-Agent": `${user}/readme-mod-stats` };
  const [profile, projects] = await Promise.all([
    getJson(`https://api.modrinth.com/v2/user/${encodeURIComponent(user)}`, headers),
    getJson(`https://api.modrinth.com/v2/user/${encodeURIComponent(user)}/projects`, headers),
  ]);
  return {
    avatarUrl: profile.avatar_url ?? null,
    projects: projects.map((p) => ({
      slug: p.slug,
      title: p.title,
      downloads: p.downloads,
      iconUrl: p.icon_url ?? null,
    })),
  };
}

async function fetchCurseForge(list) {
  const results = [];
  for (const { slug, category = "mc-mods" } of list) {
    const url = `https://api.cfwidget.com/minecraft/${category}/${slug}`;
    try {
      let body = null;
      for (let attempt = 0; attempt < 4 && !body; attempt++) {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (res.status === 202) {
          await new Promise((r) => setTimeout(r, 10_000));
          continue;
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        body = await res.json();
      }
      if (!body) throw new Error("project is still queued on cfwidget");
      if (body.error) throw new Error(String(body.error));
      const downloads = Math.round(body.downloads?.total);
      if (!Number.isFinite(downloads)) throw new Error("no downloads.total in response");
      results.push({ slug, category, title: body.title ?? slug, downloads, iconUrl: body.thumbnail ?? null });
      console.log(`curseforge ok   ${slug}: ${downloads}`);
    } catch (err) {
      console.error(`curseforge fail ${slug}: ${err.message}`);
      results.push({ slug, category, error: err.message });
    }
  }
  return results;
}

async function collect(previous) {
  let modrinth = previous?.modrinth ?? { avatarUrl: null, projects: [] };
  try {
    modrinth = await fetchModrinth(config.modrinthUser);
    console.log(`modrinth ok: ${modrinth.projects.length} projects`);
  } catch (err) {
    console.error(`modrinth fail, keeping previous numbers: ${err.message}`);
  }

  const prevCf = new Map((previous?.curseforge ?? []).map((p) => [p.slug, p]));
  const fetched = await fetchCurseForge(config.curseforge ?? []);
  const curseforge = fetched.map((p) => (p.error ? (prevCf.get(p.slug) ?? null) : p)).filter(Boolean);

  return { modrinth, curseforge };
}

function combine({ modrinth, curseforge }) {
  const pairs = config.pairs ?? {};
  const bySlug = new Map();

  for (const p of modrinth.projects) {
    bySlug.set(p.slug, { title: p.title, iconUrl: p.iconUrl, modrinth: p.downloads, curseforge: 0 });
  }
  for (const p of curseforge) {
    const key = pairs[p.slug] ?? p.slug;
    const entry = bySlug.get(key) ?? { title: p.title ?? p.slug, iconUrl: null, modrinth: 0, curseforge: 0 };
    entry.curseforge = p.downloads;
    entry.iconUrl ??= p.iconUrl ?? null;
    bySlug.set(key, entry);
  }

  const projects = [...bySlug.values()]
    .map((p) => ({ ...p, total: p.modrinth + p.curseforge }))
    .sort((a, b) => b.total - a.total);

  const mr = projects.reduce((s, p) => s + p.modrinth, 0);
  const cf = projects.reduce((s, p) => s + p.curseforge, 0);
  return { projects, totals: { modrinth: mr, curseforge: cf, all: mr + cf } };
}

function splitBar({ x, y, w, h, mr, cf, scale = 1, delay = 0 }) {
  const total = mr + cf;
  const track = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${T.track}"/>`;
  if (!total) return track;
  const full = Math.min(w, Math.max(w * scale, 2 * h + 4));
  const gap = mr && cf ? 3 : 0;
  const mrW = Math.max(mr ? h : 0, (full - gap) * (mr / total));
  const cfW = Math.max(0, full - gap - mrW);
  const anim = `style="animation-delay:${delay}ms"`;
  return [
    track,
    mr ? `<rect class="grow" ${anim} x="${x}" y="${y}" width="${mrW.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${T.modrinth}"/>` : "",
    cf ? `<rect class="grow" ${anim} x="${(x + mrW + gap).toFixed(1)}" y="${y}" width="${cfW.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${T.curseforge}"/>` : "",
  ].join("");
}

function backgroundLayer(bg, H) {
  const dim = config.background?.dim ?? 0.6;
  const blur = config.background?.blur ?? 0;
  const image = bg
    ? `<image href="${bg}" x="-${blur * 3}" y="-${blur * 3}" width="${W + blur * 6}" height="${H + blur * 6}" preserveAspectRatio="xMidYMid slice"${blur ? ` filter="url(#soft)"` : ""}/>`
    : "";
  return `
  <defs>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="14"/></clipPath>
    ${blur ? `<filter id="soft" x="0" y="0" width="100%" height="100%"><feGaussianBlur stdDeviation="${blur}"/></filter>` : ""}
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000" stop-opacity="${Math.min(1, dim + 0.15)}"/>
      <stop offset="0.55" stop-color="#000" stop-opacity="${dim}"/>
      <stop offset="1" stop-color="#000" stop-opacity="${Math.min(1, dim + 0.1)}"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="${T.base}"/>
    ${image}
    <rect width="${W}" height="${H}" fill="url(#shade)"/>
  </g>
  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${T.border}"/>`;
}

function render({ projects, totals, avatar, icons, background, updated }) {
  const rows = projects.slice(0, config.showProjects ?? 5);
  const ROW = 52;
  const listTop = 196;
  const H = rows.length ? listTop + rows.length * ROW + 34 : 176;
  const name = config.displayName ?? config.modrinthUser;
  const count = projects.length;
  const subtitle = `${config.subtitle ?? "Minecraft mods"} · ${count} ${count === 1 ? "project" : "projects"}`;
  const pct = (n) => (totals.all ? Math.round((n / totals.all) * 100) : 0);
  const shadow = `filter="url(#lift)"`;

  const avatarSvg = avatar
    ? `<clipPath id="av"><circle cx="${P + 32}" cy="${P + 32}" r="32"/></clipPath>
       <image href="${avatar}" x="${P}" y="${P}" width="64" height="64" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>
       <circle cx="${P + 32}" cy="${P + 32}" r="32" fill="none" stroke="${T.border}"/>`
    : `<circle cx="${P + 32}" cy="${P + 32}" r="32" fill="${T.tile}"/>
       <text x="${P + 32}" y="${P + 42}" text-anchor="middle" font-size="28" font-weight="700" fill="${T.muted}">${esc(name[0] ?? "?")}</text>`;

  const legend = (x, label, value, share, color) => `
    <circle cx="${x + 5}" cy="152" r="5" fill="${color}"/>
    <text x="${x + 18}" y="157" font-size="14" fill="${T.muted}" ${shadow}>${label}
      <tspan fill="${T.text}" font-weight="700" dx="6">${fmt(value)}</tspan>
      <tspan dx="6">${share}%</tspan>
    </text>`;

  const maxTotal = rows[0]?.total || 1;
  const rowsSvg = rows
    .map((p, i) => {
      const y = listTop + i * ROW;
      const icon = icons[i];
      const iconSvg = icon
        ? `<clipPath id="ic${i}"><rect x="${P}" y="${y}" width="36" height="36" rx="8"/></clipPath>
           <image href="${icon}" x="${P}" y="${y}" width="36" height="36" clip-path="url(#ic${i})" preserveAspectRatio="xMidYMid slice"/>`
        : `<rect x="${P}" y="${y}" width="36" height="36" rx="8" fill="${T.tile}"/>
           <text x="${P + 18}" y="${y + 24}" text-anchor="middle" font-size="16" font-weight="700" fill="${T.muted}">${esc(p.title[0] ?? "?")}</text>`;
      const parts = [
        p.modrinth ? `<tspan fill="${T.modrinth}">●</tspan> ${fmt(p.modrinth)}` : "",
        p.curseforge ? `<tspan fill="${T.curseforge}">●</tspan> ${fmt(p.curseforge)}` : "",
      ].filter(Boolean).join("   ");
      return `
      <g class="row" style="animation-delay:${150 + i * 90}ms">
        ${iconSvg}
        <text x="${P + 50}" y="${y + 15}" font-size="15" font-weight="600" fill="${T.text}" ${shadow}>${esc(truncate(p.title, 34))}</text>
        <text x="${P + 50}" y="${y + 33}" font-size="12" fill="${T.muted}" xml:space="preserve" ${shadow}>${parts}</text>
        ${splitBar({ x: 430, y: y + 15, w: 280, h: 6, mr: p.modrinth, cf: p.curseforge, scale: p.total / maxTotal, delay: 250 + i * 90 })}
        <text x="${W - P}" y="${y + 23}" text-anchor="end" font-size="17" font-weight="700" fill="${T.text}" ${shadow}>${fmt(p.total)}</text>
      </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <title>${esc(name)}: ${fmt(totals.all)} downloads on Modrinth and CurseForge</title>
  <style>
    .grow { transform-box: fill-box; transform-origin: left center; animation: grow .9s cubic-bezier(.2,.7,.2,1) both; }
    .row { animation: fade .5s ease-out both; }
    @keyframes grow { from { transform: scaleX(0); } }
    @keyframes fade { from { opacity: 0; transform: translateY(4px); } }
    @media (prefers-reduced-motion: reduce) { .grow, .row { animation: none; } }
  </style>
  <defs>
    <filter id="lift" x="-10%" y="-40%" width="120%" height="180%">
      <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000" flood-opacity="0.6"/>
    </filter>
  </defs>
  ${backgroundLayer(background, H)}

  ${avatarSvg}
  <text x="${P + 80}" y="${P + 28}" font-size="24" font-weight="700" fill="${T.text}" ${shadow}>${esc(name)}</text>
  <text x="${P + 80}" y="${P + 52}" font-size="14" fill="${T.muted}" ${shadow}>${esc(subtitle)}</text>

  <text x="${W - P}" y="${P + 34}" text-anchor="end" font-size="38" font-weight="800" fill="${T.text}" ${shadow}>${fmt(totals.all)}</text>
  <text x="${W - P}" y="${P + 56}" text-anchor="end" font-size="13" fill="${T.muted}" ${shadow}>total downloads</text>

  ${splitBar({ x: P, y: 116, w: W - 2 * P, h: 10, mr: totals.modrinth, cf: totals.curseforge })}
  ${legend(P, "Modrinth", totals.modrinth, pct(totals.modrinth), T.modrinth)}
  ${legend(330, "CurseForge", totals.curseforge, pct(totals.curseforge), T.curseforge)}

  ${rows.length ? `<line x1="${P}" y1="176" x2="${W - P}" y2="176" stroke="${T.border}"/>` : ""}
  ${rowsSvg}
  ${rows.length ? `<text x="${W - P}" y="${H - 14}" text-anchor="end" font-size="11" fill="${T.muted}" ${shadow}>${esc(updated)}</text>` : ""}
</svg>
`;
}

setTimeout(() => {
  console.error("build took longer than 8 minutes, aborting");
  process.exit(1);
}, 8 * 60_000).unref();

const previous = await readJson(STATS_PATH, null);
const data = await collect(previous);

const { projects, totals } = combine(data);
const shown = projects.slice(0, config.showProjects ?? 5);
const [background, avatar, ...icons] = await Promise.all([
  loadBackground(),
  iconUri(data.modrinth.avatarUrl),
  ...shown.map((p) => iconUri(p.iconUrl)),
]);
const updated = new Date().toISOString().slice(0, 10);

await writeFile(CARD_PATH, render({ projects, totals, avatar, icons, background, updated }));
await writeFile(STATS_PATH, JSON.stringify({ ...data, totals, updatedAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`total ${totals.all} (modrinth ${totals.modrinth}, curseforge ${totals.curseforge})`);
