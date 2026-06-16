import mongoose, { Schema, InferSchemaType, Model } from "mongoose";

const McpTokenSchema = new Schema(
  {
    // sha256 of the plaintext token. UNIQUE — fast lookup on every MCP call.
    tokenHash: { type: String, required: true, unique: true, index: true },
    // Last 4 chars of plaintext for UI display ("...a8f3"). Plaintext itself
    // is never stored.
    tokenSuffix: { type: String, required: true },
    // The Google account this token authorizes against.
    googleEmail: { type: String, required: true, index: true },
    // AES-256-GCM ciphertext of the Google refresh_token. See ../auth/crypto.ts.
    encryptedRefreshToken: { type: String, required: true },
    // Scopes the user consented to (snapshot at auth time).
    scopes: { type: [String], default: [] },
    // Friendly label the user gave the token (e.g., "Vikas laptop", "Cursor").
    // Optional — defaults to a generated name if not provided.
    name: { type: String, required: true, maxLength: 80 },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type McpTokenDoc = InferSchemaType<typeof McpTokenSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const McpToken: Model<McpTokenDoc> =
  (mongoose.models.McpToken as Model<McpTokenDoc>) ||
  mongoose.model<McpTokenDoc>("McpToken", McpTokenSchema);
