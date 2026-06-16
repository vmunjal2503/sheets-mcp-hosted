import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

export const config = {
  publicUrl: required("PUBLIC_URL").replace(/\/+$/, ""),
  port: parseInt(process.env.PORT || "5020", 10),
  mongoUri: required("MONGODB_URI"),
  googleClientId: required("GOOGLE_CLIENT_ID"),
  googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
  tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
};

if (!/^[0-9a-fA-F]{64}$/.test(config.tokenEncryptionKey)) {
  throw new Error(
    "TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate with: " +
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
  );
}

export const oauthRedirectUri = `${config.publicUrl}/auth/google/callback`;

export const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "openid",
  "email",
];
