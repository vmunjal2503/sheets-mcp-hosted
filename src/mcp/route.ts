import type { Application, Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { McpToken } from "../models/McpToken.js";
import { hashToken, TOKEN_PREFIX } from "../auth/routes.js";
import { decrypt } from "../auth/crypto.js";
import { clientFromRefreshToken } from "../auth/google.js";
import { registerTools } from "./tools.js";

interface AuthedRequest extends Request {
  mcpToken?: {
    id: string;
    googleEmail: string;
    refreshToken: string;
  };
}

/**
 * Validate Bearer dbw_sheets_* token. Looks up by sha256 hash,
 * decrypts the stored Google refresh_token, and attaches both to req.
 */
async function checkMcpToken(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Bearer token required" },
      id: null,
    });
    return;
  }
  const plaintext = authHeader.slice("Bearer ".length).trim();
  if (!plaintext.startsWith(TOKEN_PREFIX)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid token format" },
      id: null,
    });
    return;
  }

  try {
    const doc = await McpToken.findOne({
      tokenHash: hashToken(plaintext),
      revokedAt: null,
    });
    if (!doc) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Token not found or revoked" },
        id: null,
      });
      return;
    }
    req.mcpToken = {
      id: String(doc._id),
      googleEmail: doc.googleEmail,
      refreshToken: decrypt(doc.encryptedRefreshToken),
    };
    // Best-effort lastUsedAt update — don't block the request.
    McpToken.updateOne(
      { _id: doc._id },
      { $set: { lastUsedAt: new Date() } },
    ).catch((err) => console.error("[mcp] lastUsedAt update failed:", err));
    next();
  } catch (err: any) {
    console.error("[mcp] auth error:", err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Internal auth error" },
      id: null,
    });
  }
}

export function mountMcp(app: Application) {
  const handler = async (req: AuthedRequest, res: Response) => {
    if (!req.mcpToken) {
      res.status(500).json({ error: "missing mcpToken in context" });
      return;
    }
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const auth = clientFromRefreshToken(req.mcpToken.refreshToken);
      server = new McpServer({ name: "google-sheets", version: "0.1.0" });
      registerTools(server, auth);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });

      res.on("close", () => {
        try {
          transport?.close();
          server?.close();
        } catch {
          // already torn down
        }
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error("[mcp] handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", checkMcpToken, handler);
  app.get("/mcp", checkMcpToken, handler);
  app.delete("/mcp", checkMcpToken, handler);
}
