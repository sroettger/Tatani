import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createServiceAccountJwt, parseFirebaseServiceAccount, sendFcmWebPush } from "../../supabase/functions/_shared/fcm";

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
});
