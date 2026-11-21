import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createServiceAccountJwt, parseFirebaseServiceAccount, sendFcmWebPush } from "../../supabase/functions/_shared/fcm";
import { applyMigrationsViaApi, resolveOrCreateProject } from "../../scripts/provision-supabase.mjs";

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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
