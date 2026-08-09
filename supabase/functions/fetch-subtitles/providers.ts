// Subtitle providers. Each provider takes a search context and returns a hit or null.
import { fetchSubtitleFile, scoreFilename } from "../_shared/subtitles.ts";

export type SubtitleContext = {
  /** ISO language code we want subtitles in, e.g. "de" */
  lang: string;
  titleRomaji: string;
  titleEn: string;
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

const UA = "Tatani v1.0";

const titles = (ctx: SubtitleContext) =>
  [ctx.titleRomaji, ctx.titleEn].filter((t): t is string => !!t && t.trim().length > 0);

/* ------------------------------- Jimaku (ja) ------------------------------ */

const jimaku: SubtitleProvider = {
  name: "jimaku",
  langs: ["ja"],
  async run(ctx) {
    const key = Deno.env.get("JIMAKU_API_KEY");
    if (!key) throw new Error("missing JIMAKU_API_KEY");
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
    const ranked = [...files]
      .filter((f: any) => typeof f?.name === "string" && f?.url)
      .sort((a: any, b: any) =>
        scoreFilename(b.name, ctx.season, ctx.episode) - scoreFilename(a.name, ctx.season, ctx.episode));
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
  const user = Deno.env.get("OPENSUBTITLES_USERNAME");
  const pass = Deno.env.get("OPENSUBTITLES_PASSWORD");
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

const openSubtitles: SubtitleProvider = {
  name: "opensubtitles",
  langs: "*",
  async run(ctx) {
    const apiKey = Deno.env.get("OPENSUBTITLES_API_KEY");
    if (!apiKey) throw new Error("missing OPENSUBTITLES_API_KEY");
    const headers = { "Api-Key": apiKey, "User-Agent": UA, "Content-Type": "application/json" };

    let best: any = null;
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
      const items: any[] = Array.isArray(json?.data) ? json.data : [];
      const withFile = items.find((i) => i?.attributes?.files?.[0]?.file_id);
      if (withFile) { best = withFile; break; }
    }
    if (!best) return null;

    const token = await openSubtitlesToken(apiKey);
    if (!token) throw new Error("missing OPENSUBTITLES_USERNAME/PASSWORD");
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

const subdl: SubtitleProvider = {
  name: "subdl",
  langs: "*",
  async run(ctx) {
    const key = Deno.env.get("SUBDL_API_KEY");
    if (!key) throw new Error("missing SUBDL_API_KEY");
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
      const subs: any[] = Array.isArray(json?.subtitles) ? json.subtitles : [];
      const ranked = subs
        .filter((s) => typeof s?.url === "string")
        .sort((a, b) =>
          scoreFilename(b.release_name ?? b.url, ctx.season, ctx.episode) -
          scoreFilename(a.release_name ?? a.url, ctx.season, ctx.episode));
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
      let json: any;
      try { json = await res.json(); } catch { return null; }
      const items: any[] = Array.isArray(json?.data) ? json.data : [];
      for (const item of items.slice(0, 3)) {
        const href: string | undefined = item?.download
          ? (String(item.download).startsWith("http") ? item.download : `https://www.podnapisi.net${item.download}`)
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
  const all = [jimaku, openSubtitles, subdl, podnapisi];
  return all.filter((p) => p.langs === "*" || p.langs.includes(lang));
}
