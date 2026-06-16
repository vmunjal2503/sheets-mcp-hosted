import express from "express";
import cookieParser from "cookie-parser";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { connectDb } from "./db.js";
import authRoutes from "./auth/routes.js";
import { mountMcp } from "./mcp/route.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  await connectDb();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true); // nginx in front

  // MCP needs raw JSON body for JSON-RPC framing. Other routes work fine
  // with the same parser since they expect JSON or are URL-encoded redirects.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Health check for nginx / uptime monitors.
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Auth flow.
  app.use("/auth", authRoutes);

  // MCP transport. Bearer-token protected.
  mountMcp(app);

  // Static landing page. Served LAST so /auth/* and /mcp take precedence.
  app.use(express.static(join(__dirname, "..", "public")));

  app.listen(config.port, () => {
    console.log(
      `[sheets-mcp-hosted] listening on :${config.port} (public ${config.publicUrl})`,
    );
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
