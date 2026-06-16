import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { config, oauthRedirectUri } from "../config.js";

/** A bare OAuth2 client (no creds attached). Used to generate consent URLs. */
export function newConsentClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    oauthRedirectUri,
  );
}

/**
 * Build an authenticated OAuth2 client from a stored refresh_token.
 * The library handles access_token refresh automatically on Google API calls.
 */
export function clientFromRefreshToken(refreshToken: string): OAuth2Client {
  const client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    oauthRedirectUri,
  );
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
