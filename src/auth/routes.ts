import { Router, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

import { config, oauthRedirectUri, SCOPES } from "../config.js";
import { newConsentClient } from "./google.js";
import { encrypt } from "./crypto.js";
import { McpToken } from "../models/McpToken.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = join(__dirname, "..", "..", "public");

const router = Router();

const TOKEN_PREFIX = "dbw_sheets_";

function generateMcpToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Lightweight template fill: replaces {{KEY}} occurrences. */
function render(html: string, vars: Record<string, string>): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]! : `{{${k}}}`,
  );
}

const CONNECTED_HTML = readFileSync(join(VIEWS_DIR, "connected.html"), "utf8");

/**
 * GET /auth/google — Start the consent flow.
 *
 * Accepts ?name=<label> so the user can tag the token (e.g. "my-laptop").
 * The name round-trips through OAuth state because Google forwards it
 * to us on callback unchanged.
 */
router.get("/google", (req: Request, res: Response) => {
  const name =
    (typeof req.query.name === "string" && req.query.name.trim()) ||
    `Connection ${new Date().toISOString().slice(0, 10)}`;
  const oauth = newConsentClient();
  const state = Buffer.from(JSON.stringify({ name })).toString("base64url");
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
  res.redirect(url);
});

/**
 * GET /auth/google/callback — Google redirects here with ?code=... or ?error=...
 */
router.get("/google/callback", async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const errorParam =
    typeof req.query.error === "string" ? req.query.error : null;
  const stateRaw =
    typeof req.query.state === "string" ? req.query.state : null;

  if (errorParam) {
    res
      .status(400)
      .send(
        `<h2>Authorization failed: ${errorParam}</h2><p>Close this tab and try again.</p>`,
      );
    return;
  }
  if (!code) {
    res.status(400).send(`<h2>Missing code parameter</h2>`);
    return;
  }

  let name = `Connection ${new Date().toISOString().slice(0, 10)}`;
  if (stateRaw) {
    try {
      const decoded = JSON.parse(
        Buffer.from(stateRaw, "base64url").toString("utf8"),
      );
      if (decoded?.name && typeof decoded.name === "string") {
        name = decoded.name.slice(0, 80);
      }
    } catch {
      // ignore — keep default name
    }
  }

  try {
    const oauth = newConsentClient();
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      res
        .status(400)
        .send(
          `<h2>Google did not return a refresh_token</h2>` +
            `<p>Revoke the app at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and try again.</p>`,
        );
      return;
    }

    // Fetch the authenticated user's email via the OpenID userinfo endpoint.
    oauth.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth });
    const userinfo = await oauth2.userinfo.get();
    const googleEmail = userinfo.data.email || "unknown@example.com";

    const plaintextToken = generateMcpToken();
    await McpToken.create({
      tokenHash: hashToken(plaintextToken),
      tokenSuffix: plaintextToken.slice(-4),
      googleEmail,
      encryptedRefreshToken: encrypt(tokens.refresh_token),
      scopes: (tokens.scope || SCOPES.join(" ")).split(" "),
      name,
    });

    const claudeCmd = `claude mcp add --transport http --scope user google-sheets ${config.publicUrl}/mcp --header "Authorization: Bearer ${plaintextToken}"`;

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(
      render(CONNECTED_HTML, {
        TOKEN: plaintextToken,
        CLAUDE_CMD: claudeCmd,
        GOOGLE_EMAIL: googleEmail,
        NAME: name,
        PUBLIC_URL: config.publicUrl,
      }),
    );
  } catch (err: any) {
    console.error("OAuth callback error:", err);
    res
      .status(500)
      .send(`<h2>Auth callback failed</h2><pre>${err.message}</pre>`);
  }
});

export default router;
export { TOKEN_PREFIX, hashToken };
