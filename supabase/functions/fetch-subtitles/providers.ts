// Subtitle providers. Each provider takes a search context and returns a hit or null.
import { fetchSubtitleFile, scoreFilename } from "../_shared/subtitles.ts";
import { kitsuSanitizeDirName, scoreEpisodeFilename } from "./kitsuMatch.ts";

export { kitsuSanitizeDirName, scoreEpisodeFilename };

export type SubtitleContext = {
  /** ISO language code we want subtitles in, e.g. "ja" or "de" */
  lang: string;
  titleRomaji: string;
  titleEn: string;
  titleJp?: string;
  anilistId?: number | null;
  malId?: number | null;
  season: number;
  episode: number;
};

export type SubtitleHit = {
  content: string;
  filename: string;
  provider: string;
};

export type SubtitleProvider = {
  name: string;
  /** Languages this provider supports; "*" means all. */
  langs: string[] | "*";
  run: (ctx: SubtitleContext) => Promise<SubtitleHit | null>;
};

const UA = "Tatani v2.0";

const titles = (ctx: SubtitleContext): string[] =>
  Array.from(
    new Set(
      [ctx.titleRomaji, ctx.titleEn, ctx.titleJp ?? ""]
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  );

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeLookupKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function expandTitleVariants(ctx: SubtitleContext): string[] {
  const out = new Set<string>();
  for (const base of titles(ctx)) {
    out.add(base);
    out.add(base.replace(/\s*x\s*/gi, "×"));
    out.add(base.replace(/×/g, " x "));
    const mSeason = /^(.*?)\s+Season\s+(\d+)$/i.exec(base);
    if (mSeason) {
      const n = Number(mSeason[2]);
      const ord = n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
      out.add(`${mSeason[1]} ${ord} Season`);
      out.add(`${mSeason[1]} ${n}`);
    }
    const mOrd = /^(.*?)\s+(\d+)(?:nd|rd|th)\s+Season$/i.exec(base);
    if (mOrd) {
      out.add(`${mOrd[1]} Season ${mOrd[2]}`);
      out.add(`${mOrd[1]} ${mOrd[2]}`);
    }
  }
  return Array.from(out).filter((v) => v.trim().length > 0);
}

type CatalogIndexEntry = {
  href: string;
  keys: string[];
};

let cachedCatalogIndex: { fetchedAt: number; entries: CatalogIndexEntry[] } | null = null;

async function getAjattCatalogIndex(): Promise<CatalogIndexEntry[]> {
  const now = Date.now();
  if (cachedCatalogIndex && now - cachedCatalogIndex.fetchedAt < 30 * 60 * 1000) {
    return cachedCatalogIndex.entries;
  }
  const res = await fetch("https://subtitles.ajatt.top/", { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const html = await res.text();
  const entries: CatalogIndexEntry[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    const linkMatch = /class="entry_name"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(row);
    if (!linkMatch) continue;
    const href = decodeHtmlEntities(linkMatch[1]);
    const entryName = decodeHtmlEntities(linkMatch[2]);
    const engMatch = /class="english_name"[^>]*>([^<]*)</.exec(row);
    const jpMatch = /class="japanese_name"[^>]*>([^<]*)</.exec(row);
    const keys = [entryName, engMatch ? decodeHtmlEntities(engMatch[1]) : "", jpMatch ? decodeHtmlEntities(jpMatch[1]) : ""]
      .map(normalizeLookupKey)
      .filter((k) => k.length > 0);
    if (keys.length > 0) entries.push({ href, keys });
  }
  cachedCatalogIndex = { fetchedAt: now, entries };
  return entries;
}

async function pickFromAjattEntryHtml(
  html: string,
  isMovie: boolean,
  ctx: SubtitleContext,
): Promise<SubtitleHit | null> {
  const pairs: Array<{ url: string; filename: string }> = [];
  const re = /data-download-url="([^"]+)"\s+data-filename="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    pairs.push({
      url: decodeHtmlEntities(m[1]),
      filename: decodeHtmlEntities(m[2]),
    });
  }
  if (pairs.length === 0) return null;

  const allowMovie = isMovie || pairs.length === 1;
  const ranked = pairs
    .map((p) => ({ ...p, score: scoreEpisodeFilename(p.filename, ctx.season, ctx.episode, allowMovie) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const candidate of ranked.slice(0, 4)) {
    const file = await fetchSubtitleFile(candidate.url, ctx.season, ctx.episode, {
      headers: { "User-Agent": UA },
    });
    if (file) {
      return { content: file.text, filename: candidate.filename, provider: "kitsunekko-mirror" };
    }
  }
  return null;
}

/* --------------------- Kitsunekko Mirror (keyless, ja) -------------------- */

const kitsunekkoMirror: SubtitleProvider = {
  name: "kitsunekko-mirror",
  langs: ["ja"],
  async run(ctx) {
    const variants = expandTitleVariants(ctx);
    const categories = ["anime_tv", "anime_movie", "unsorted"];

    // 1. Direct O(1) static page lookup on subtitles.ajatt.top
    const triedHrefs = new Set<string>();
    for (const v of variants) {
      const sanitized = kitsuSanitizeDirName(v);
      if (!sanitized) continue;
      const slug = encodeURIComponent(sanitized.toLowerCase().replace(/[ _]/g, "-"));
      for (const cat of categories) {
        const relHref = `${cat}/${slug}.html`;
        if (triedHrefs.has(relHref)) continue;
        triedHrefs.add(relHref);
        const res = await fetch(`https://subtitles.ajatt.top/${relHref}`, {
          headers: { "User-Agent": UA },
        });
        if (!res.ok) continue;
        const html = await res.text();
        const hit = await pickFromAjattEntryHtml(html, cat === "anime_movie", ctx);
        if (hit) return hit;
      }
    }

    // 2. Fuzzy catalog lookup across all 3,600+ entries on subtitles.ajatt.top
    try {
      const targetKeys = new Set(variants.map(normalizeLookupKey).filter((k) => k.length > 0));
      if (targetKeys.size > 0) {
        const catalog = await getAjattCatalogIndex();
        const matchedEntries = catalog.filter((entry) => entry.keys.some((k) => targetKeys.has(k)));
        for (const entry of matchedEntries.slice(0, 4)) {
          if (triedHrefs.has(entry.href)) continue;
          triedHrefs.add(entry.href);
          const res = await fetch(`https://subtitles.ajatt.top/${entry.href}`, {
            headers: { "User-Agent": UA },
          });
          if (!res.ok) continue;
          const html = await res.text();
          const hit = await pickFromAjattEntryHtml(html, entry.href.startsWith("anime_movie/"), ctx);
          if (hit) return hit;
        }
      }
    } catch (err) {
      console.warn("Ajatt catalog fallback failed:", err instanceof Error ? err.message : err);
    }

    // 3. Direct raw.githubusercontent.com .kitsuignore fallback if subtitles.ajatt.top is unavailable
    const rawBase = "https://raw.githubusercontent.com/Ajatt-Tools/kitsunekko-mirror/main/subtitles";
    for (const v of variants) {
      const dirName = kitsuSanitizeDirName(v);
      if (!dirName) continue;
      for (const cat of categories) {
        const dirUrl = `${rawBase}/${cat}/${encodeURIComponent(dirName)}`;
        const igResp = await fetch(`${dirUrl}/.kitsuignore`, { headers: { "User-Agent": UA } });
        if (!igResp.ok) continue;
        const lines = (await igResp.text()).split(/\r?\n/).slice(1);
        const filenames = lines
          .map((l) => l.split("\t")[0]?.trim() ?? "")
          .filter((fn) => /\.(srt|ass|ssa|vtt)$/i.test(fn));
        const ranked = filenames
          .map((fn) => ({
            fn,
            score: scoreEpisodeFilename(fn, ctx.season, ctx.episode, cat === "anime_movie" || filenames.length === 1),
          }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);
        for (const cand of ranked.slice(0, 4)) {
          const encodedPath = cand.fn.split("/").map(encodeURIComponent).join("/");
          const file = await fetchSubtitleFile(`${dirUrl}/${encodedPath}`, ctx.season, ctx.episode, {
            headers: { "User-Agent": UA },
          });
          if (file) return { content: file.text, filename: cand.fn, provider: "kitsunekko-mirror" };
        }
      }
    }

    return null;
  },
};

/* ------------------------------- Jimaku (ja) ------------------------------ */

type JimakuFile = { name?: string; url?: string };

const jimaku: SubtitleProvider = {
  name: "jimaku",
  langs: ["ja"],
  async run(ctx) {
    const key = Deno.env.get("JIMAKU_API_KEY")?.trim();
    if (!key) return null;
    const searchUrl = ctx.anilistId
      ? `https://jimaku.cc/api/entries/search?anilist_id=${ctx.anilistId}`
      : `https://jimaku.cc/api/entries/search?query=${encodeURIComponent(titles(ctx)[0] ?? "")}`;
    const sr = await fetch(searchUrl, { headers: { Authorization: key } });
    if (!sr.ok) throw new Error(`search ${sr.status}`);
    const entries = await sr.json();
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const fr = await fetch(`https://jimaku.cc/api/entries/${entries[0].id}/files`, {
      headers: { Authorization: key },
    });
    if (!fr.ok) throw new Error(`files ${fr.status}`);
    const files = await fr.json();
    if (!Array.isArray(files) || files.length === 0) return null;
    const ranked = (files as JimakuFile[])
      .filter((f): f is Required<JimakuFile> => typeof f?.name === "string" && typeof f?.url === "string")
      .map((f) => ({ ...f, score: scoreEpisodeFilename(f.name, ctx.season, ctx.episode) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score);
    const match = ranked[0];
    if (!match) return null;
    const file = await fetchSubtitleFile(match.url, ctx.season, ctx.episode);
    if (!file) return null;
    return { content: file.text, filename: file.filename, provider: "jimaku" };
  },
};

/* ----------------------------- OpenSubtitles ------------------------------ */

let osTokenCache: string | null = null;

async function openSubtitlesToken(apiKey: string): Promise<string | null> {
  if (osTokenCache) return osTokenCache;
  const user = Deno.env.get("OPENSUBTITLES_USERNAME")?.trim();
  const pass = Deno.env.get("OPENSUBTITLES_PASSWORD")?.trim();
  if (!user || !pass) return null;
  const res = await fetch("https://api.opensubtitles.com/api/v1/login", {
    method: "POST",
    headers: { "Api-Key": apiKey, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const json = await res.json();
  osTokenCache = json?.token ?? null;
  return osTokenCache;
}

type OpenSubItem = { attributes?: { files?: Array<{ file_id?: number }> } };

const openSubtitles: SubtitleProvider = {
  name: "opensubtitles",
  langs: "*",
  async run(ctx) {
    const apiKey = Deno.env.get("OPENSUBTITLES_API_KEY")?.trim();
    if (!apiKey) return null;
    const headers = { "Api-Key": apiKey, "User-Agent": UA, "Content-Type": "application/json" };

    let best: OpenSubItem | null = null;
    for (const title of titles(ctx)) {
      const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
      url.searchParams.set("query", title);
      url.searchParams.set("languages", ctx.lang);
      url.searchParams.set("season_number", String(ctx.season));
      url.searchParams.set("episode_number", String(ctx.episode));
      url.searchParams.set("order_by", "download_count");
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`search ${res.status}`);
      const json = await res.json();
      const items: OpenSubItem[] = Array.isArray(json?.data) ? json.data : [];
      const withFile = items.find((i) => i?.attributes?.files?.[0]?.file_id);
      if (withFile) {
        best = withFile;
        break;
      }
    }
    if (!best?.attributes?.files?.[0]?.file_id) return null;

    const token = await openSubtitlesToken(apiKey);
    if (!token) return null;
    const fileId = best.attributes.files[0].file_id;
    const dl = await fetch("https://api.opensubtitles.com/api/v1/download", {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!dl.ok) throw new Error(`download ${dl.status}`);
    const link = (await dl.json())?.link;
    if (!link) return null;
    const file = await fetchSubtitleFile(link, ctx.season, ctx.episode, { headers: { "User-Agent": UA } });
    if (!file) return null;
    return { content: file.text, filename: file.filename, provider: "opensubtitles" };
  },
};

/* --------------------------------- SubDL ---------------------------------- */

type SubdlItem = { url?: string; release_name?: string };

const subdl: SubtitleProvider = {
  name: "subdl",
  langs: "*",
  async run(ctx) {
    const key = Deno.env.get("SUBDL_API_KEY")?.trim();
    if (!key) return null;
    for (const title of titles(ctx)) {
      const url = new URL("https://api.subdl.com/api/v1/subtitles");
      url.searchParams.set("api_key", key);
      url.searchParams.set("film_name", title);
      url.searchParams.set("languages", ctx.lang.toUpperCase());
      url.searchParams.set("season_number", String(ctx.season));
      url.searchParams.set("episode_number", String(ctx.episode));
      url.searchParams.set("subs_per_page", "10");
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`search ${res.status}`);
      const json = await res.json();
      const subs: SubdlItem[] = Array.isArray(json?.subtitles) ? json.subtitles : [];
      const ranked = subs
        .filter((s): s is SubdlItem & { url: string } => typeof s?.url === "string")
        .sort(
          (a, b) =>
            scoreFilename(b.release_name ?? b.url, ctx.season, ctx.episode) -
            scoreFilename(a.release_name ?? a.url, ctx.season, ctx.episode),
        );
      for (const s of ranked.slice(0, 3)) {
        const href = s.url.startsWith("http") ? s.url : `https://dl.subdl.com${s.url}`;
        const file = await fetchSubtitleFile(href, ctx.season, ctx.episode, { headers: { "User-Agent": UA } });
        if (file) return { content: file.text, filename: file.filename, provider: "subdl" };
      }
    }
    return null;
  },
};

/* ------------------------------- Podnapisi -------------------------------- */

type PodnapisiItem = { download?: string };

const podnapisi: SubtitleProvider = {
  name: "podnapisi",
  langs: "*",
  async run(ctx) {
    for (const title of titles(ctx)) {
      const url = new URL("https://www.podnapisi.net/subtitles/search/advanced");
      url.searchParams.set("keywords", title);
      url.searchParams.set("seasons", String(ctx.season));
      url.searchParams.set("episodes", String(ctx.episode));
      url.searchParams.set("language", ctx.lang);
      url.searchParams.set("format", "json");
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`search ${res.status}`);
      let parsed: { data?: PodnapisiItem[] } | null = null;
      try {
        parsed = await res.json();
      } catch {
        return null;
      }
      const items: PodnapisiItem[] = Array.isArray(parsed?.data) ? parsed.data : [];
      for (const item of items.slice(0, 3)) {
        const href: string | undefined = item?.download
          ? String(item.download).startsWith("http")
            ? String(item.download)
            : `https://www.podnapisi.net${item.download}`
          : undefined;
        if (!href) continue;
        const file = await fetchSubtitleFile(href, ctx.season, ctx.episode, { headers: { "User-Agent": UA } });
        if (file) return { content: file.text, filename: file.filename, provider: "podnapisi" };
      }
    }
    return null;
  },
};

/** Ordered provider chain for a given language. */
export function providersFor(lang: string): SubtitleProvider[] {
  const all = [jimaku, kitsunekkoMirror, openSubtitles, subdl, podnapisi];
  return all.filter((p) => p.langs === "*" || p.langs.includes(lang));
}
