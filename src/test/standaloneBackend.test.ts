import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createServiceAccountJwt, parseFirebaseServiceAccount, sendFcmWebPush } from "../../supabase/functions/_shared/fcm";
import { sanitizeToolsForGemini } from "../../supabase/functions/_shared/ai";
import { kitsuSanitizeDirName, scoreEpisodeFilename } from "../../supabase/functions/fetch-subtitles/kitsuMatch";
import {
  applyMigrationsViaApi,
  repairCatalogEpisodesAndReport,
  resolveOrCreateProject,
} from "../../scripts/provision-supabase.mjs";

function arrayBufferToPem(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

describe("standalone FCM HTTP v1 sender", () => {
  it("signs valid RS256 service account JWTs and sends direct FCM HTTP v1 webpush payloads", async () => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    }
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const pem = arrayBufferToPem(pkcs8);

    const rawSa = JSON.stringify({
      project_id: "tatani-standalone",
      client_email: "firebase-adminsdk@tatani-standalone.iam.gserviceaccount.com",
      private_key: pem,
    });

    const sa = parseFirebaseServiceAccount(rawSa);
    expect(sa.project_id).toBe("tatani-standalone");

    const jwt = await createServiceAccountJwt(sa, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.standalone-token", expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "projects/tatani-standalone/messages/123" }), { status: 200 }),
      );

    const resp = await sendFcmWebPush(
      "device-fcm-token-xyz",
      { delivery_id: "d-1", word: "魔法", l_know: "I know" },
      rawSa,
      mockFetch as unknown as typeof fetch,
    );

    expect(resp.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    expect(mockFetch.mock.calls[1][0]).toBe("https://fcm.googleapis.com/v1/projects/tatani-standalone/messages:send");
    const sentBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body));
    expect(sentBody).toEqual({
      message: {
        token: "device-fcm-token-xyz",
        data: { delivery_id: "d-1", word: "魔法", l_know: "I know" },
        webpush: { headers: { TTL: "3600", Urgency: "high" } },
      },
    });
  });

  it("auto-creates a Tatani Supabase project and applies unapplied SQL migrations from SUPABASE_ACCESS_TOKEN alone", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tatani-mig-"));
    try {
      writeFileSync(path.join(dir, "20260418000000_init.sql"), "CREATE TABLE t1 (id int);");
      writeFileSync(path.join(dir, "20261101120000_push.sql"), "CREATE TABLE t2 (id int);");

      const mockFetch = vi.fn()
        // GET /projects -> empty
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
        // GET /organizations
        .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "org-123" }]), { status: 200 }))
        // POST /projects
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: "refabcdefghijklmno" }), { status: 201 }))
        // GET /projects/refabcdefghijklmno -> ACTIVE_HEALTHY
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: "refabcdefghijklmno", status: "ACTIVE_HEALTHY" }), { status: 200 }))
        // GET /projects/refabcdefghijklmno/api-keys
        .mockResolvedValueOnce(new Response(JSON.stringify([{ name: "anon", api_key: "anon-public-jwt" }]), { status: 200 }))
        // POST /database/query (create schema_migrations)
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 201 }))
        // POST /database/query (select versions -> first migration already applied)
        .mockResolvedValueOnce(new Response(JSON.stringify([{ version: "20260418000000" }]), { status: 201 }))
        // POST /database/query (apply 20261101120000_push.sql)
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 201 }))
        // POST /database/query (record 20261101120000)
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 201 }))
        // PATCH /config/auth
        .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const resolved = await resolveOrCreateProject({
        token: "sbp_test_token",
        explicitProjectId: "",
        autoCreate: true,
        fetchImpl: mockFetch as unknown as typeof fetch,
        sleep: async () => {},
      });

      expect(resolved).toEqual({
        projectId: "refabcdefghijklmno",
        supabaseUrl: "https://refabcdefghijklmno.supabase.co",
        supabaseAnonKey: "anon-public-jwt",
      });

      await applyMigrationsViaApi({
        token: "sbp_test_token",
        projectId: resolved.projectId,
        migrationsDir: dir,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      expect(mockFetch).toHaveBeenCalledTimes(10);
      const thirdSqlBody = JSON.parse(String(mockFetch.mock.calls[7][1]?.body));
      expect(thirdSqlBody.query).toBe("CREATE TABLE t2 (id int);");
      const authPatchBody = JSON.parse(String(mockFetch.mock.calls[9][1]?.body));
      expect(authPatchBody.mailer_autoconfirm).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs 0-episode airing anime catalog entries using AniList nextAiringEpisode and Jikan", async () => {
    const mockFetch = vi.fn()
      // 1. SELECT anime rows -> 1 ongoing anime with 0 episodes
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "anime-uuid-1",
              anilist_id: 21,
              mal_id: 21,
              title_romaji: "ONE PIECE",
              episode_count: 0,
              seasons_count: 1,
              episodes_count: 0,
              linked_count: 1,
            },
          ]),
          { status: 201 },
        ),
      )
      // 2. AniList GraphQL Media lookup -> episodes: null, nextAiringEpisode: { episode: 4 }
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { Media: { episodes: null, format: "TV", status: "RELEASING", nextAiringEpisode: { episode: 4 } } },
          }),
          { status: 200 },
        ),
      )
      // 3. Jikan episodes page 1
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            pagination: { has_next_page: false, items: { total: 3 } },
            data: [
              { mal_id: 1, title: "I'm Luffy!", title_japanese: "俺はルフィ！" },
              { mal_id: 2, title: "Enter the Great Swordsman!", title_japanese: "大剣豪現る！" },
              { mal_id: 3, title: "Morgan versus Luffy!", title_japanese: "モーガンVSルフィ！" },
            ],
          }),
          { status: 200 },
        ),
      )
      // 4. INSERT/UPSERT season 1
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "season-uuid-1" }]), { status: 201 }))
      // 5. INSERT episodes + UPDATE anime.episode_count
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 201 }))
      // 6. Health report query
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ anime_count: 1, episodes_count: 3, user_anime_count: 1 }]),
          { status: 201 },
        ),
      )
      // 7. Authenticated RLS check
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ rls_user_anime: 1, rls_episodes: 3 }]),
          { status: 201 },
        ),
      );

    await repairCatalogEpisodesAndReport({
      token: "sbp_test_token",
      projectId: "refabcdefghijklmno",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(7);
    const insertEpisodesSql = JSON.parse(String(mockFetch.mock.calls[4][1]?.body)).query as string;
    expect(insertEpisodesSql).toContain("INSERT INTO public.episodes");
    expect(insertEpisodesSql).toContain("I''m Luffy!");
    expect(insertEpisodesSql).toContain("GREATEST(episode_count, 3)");
  });

  it("matches Kitsunekko directory names, scores episode filenames without false positives, and strips additionalProperties for Gemini", () => {
    expect(kitsuSanitizeDirName("Cyberpunk: Edgerunners 2")).toBe("Cyberpunk. Edgerunners 2");
    expect(kitsuSanitizeDirName("Ranma 1/2 (2024)")).toBe("Ranma 1∕2 (2024)");
    expect(kitsuSanitizeDirName("Zutto Dokushin de Iru Tsumori?")).toBe("Zutto Dokushin de Iru Tsumori？");

    const ep2File = "Cyberpunk .Edgerunners.S02E02.Give.Me.Another.Day.WEBRip.Netflix.ja[cc].srt";
    const ep3TrickyTitle = "Cyberpunk .Edgerunners.S02E03.0+2=1.WEBRip.Netflix.ja[cc].srt";
    expect(scoreEpisodeFilename(ep2File, 1, 2)).toBeGreaterThan(scoreEpisodeFilename(ep3TrickyTitle, 1, 2));
    expect(scoreEpisodeFilename(ep2File, 1, 99)).toBe(-1);
    expect(scoreEpisodeFilename("Movie.2024.WEBRip.ja.srt", 1, 1, true)).toBeGreaterThan(0);

    const sanitized = sanitizeToolsForGemini([
      {
        type: "function",
        function: {
          name: "translate",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              item: { type: "object", additionalProperties: false, properties: { word: { type: "string" } } },
            },
          },
        },
      },
    ]) as Array<{ function: { parameters: Record<string, unknown> } }>;

    expect("additionalProperties" in sanitized[0].function.parameters).toBe(false);
    const itemProp = (sanitized[0].function.parameters.properties as Record<string, Record<string, unknown>>).item;
    expect("additionalProperties" in itemProp).toBe(false);
  });
});
