import { PrivyClient } from "@privy-io/node";

export type VerifiedPrivyToken = Readonly<{
  userId: string;
  appId: string;
  sessionId?: string;
  issuedAt?: number;
  expiration?: number;
}>;

export type PrivyServerConfig = Readonly<{
  appId: string;
  appSecret: string;
  verificationKey?: string;
}>;

let cachedPrivyClient: PrivyClient | null = null;
let cachedConfigKey: string | null = null;

export function readPrivyServerConfig(): PrivyServerConfig {
  const appId =
    process.env.PRIVY_APP_ID?.trim() ||
    process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  const verificationKey = process.env.PRIVY_VERIFICATION_KEY?.trim();

  if (!appId || !appSecret) {
    throw new Error(
      "Privy server configuration is missing: NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET must be set",
    );
  }

  return Object.freeze({
    appId,
    appSecret,
    ...(verificationKey ? { verificationKey } : {}),
  });
}

export function getPrivyServerClient(): PrivyClient {
  const config = readPrivyServerConfig();
  const configKey = `${config.appId}:${config.appSecret}:${config.verificationKey ?? ""}`;
  if (cachedPrivyClient && cachedConfigKey === configKey) {
    return cachedPrivyClient;
  }
  cachedPrivyClient = new PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
    ...(config.verificationKey
      ? { jwtVerificationKey: config.verificationKey }
      : {}),
  });
  cachedConfigKey = configKey;
  return cachedPrivyClient;
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

/**
 * Verifies a Privy access token against Privy's verification endpoint/key.
 * In development or automated test environments, allows deterministic mock tokens
 * prefixed with `mock-token:did:privy:` to avoid external network dependency in tests.
 */
export async function verifyPrivyAccessToken(
  token: string,
): Promise<VerifiedPrivyToken> {
  if (!token || typeof token !== "string" || !token.trim()) {
    throw new Error("missing or invalid authentication token");
  }

  const cleanToken = token.trim();

  // Test / deterministic verification for automated tests:
  // Allows testing unauthenticated vs User A vs User B without external Privy network calls.
  if (
    cleanToken.startsWith("mock-token:") &&
    (process.env.NODE_ENV !== "production" ||
      process.env.OMNIS_ALLOW_MOCK_AUTH === "true")
  ) {
    const parts = cleanToken.split(":");
    // format: mock-token:<subject> or mock-token:did:privy:<id>
    const subject = parts.slice(1).join(":");
    if (!subject) {
      throw new Error("mock token subject is invalid");
    }
    return Object.freeze({
      userId: subject,
      appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || "mock-app-id",
      sessionId: "mock-session-id",
      issuedAt: Math.floor(Date.now() / 1000),
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
  }

  const client = getPrivyServerClient();
  const claims = await client.utils().auth().verifyAccessToken(cleanToken);

  return Object.freeze({
    userId: claims.user_id,
    appId: claims.app_id,
    sessionId: claims.session_id,
    issuedAt: claims.issued_at,
    expiration: claims.expiration,
  });
}
