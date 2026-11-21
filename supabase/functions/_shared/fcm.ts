// Direct Firebase Cloud Messaging HTTP v1 sender using standard Google Service Account OAuth2 JWTs.

export interface FirebaseServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedToken: { accessToken: string; expiresAtMs: number; projectId: string } | null = null;

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeJson(obj: unknown): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToPkcs8Der(pem: string): ArrayBuffer {
  const normalized = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(normalized);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

export function parseFirebaseServiceAccount(rawJson: string | undefined): FirebaseServiceAccount {
  if (!rawJson?.trim()) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  }
  const parsed = JSON.parse(rawJson) as Partial<FirebaseServiceAccount>;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email, or private_key");
  }
  return {
    project_id: parsed.project_id,
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri || "https://oauth2.googleapis.com/token",
  };
}

export async function createServiceAccountJwt(
  sa: FirebaseServiceAccount,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Der(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

async function getFcmAccessToken(
  sa: FirebaseServiceAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (
    cachedToken &&
    cachedToken.projectId === sa.project_id &&
    cachedToken.expiresAtMs - 60_000 > Date.now()
  ) {
    return cachedToken.accessToken;
  }
  const assertion = await createServiceAccountJwt(sa);
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const resp = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!resp.ok) {
    const details = await resp.text();
    throw new Error(`FCM OAuth token exchange failed [${resp.status}]: ${details}`);
  }
  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("FCM OAuth token response missing access_token");
  }
  cachedToken = {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    projectId: sa.project_id,
  };
  return json.access_token;
}

export async function sendFcmWebPush(
  deviceToken: string,
  data: Record<string, string>,
  serviceAccountJson: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const sa = parseFirebaseServiceAccount(serviceAccountJson);
  const accessToken = await getFcmAccessToken(sa, fetchImpl);
  return await fetchImpl(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          data,
          webpush: {
            headers: {
              TTL: "3600",
              Urgency: "high",
            },
          },
        },
      }),
    },
  );
}
