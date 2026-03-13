import express from "express";
import cors from "cors";
import { config, validateConfig } from "./config/index.js";
import { checkDatabaseHealth, closePool } from "./config/database.js";
import { getSchemaContext, clearSchemaCache } from "./agents/schemaSelector.js";
import { processQuery } from "./orchestrator.js";
import type { QueryRequest, QueryResponse } from "./types/index.js";

// ─── Initialize ──────────────────────────────────────────────────────────────

validateConfig();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Health Check
 */
app.get("/api/health", async (_req, res) => {
  const dbHealthy = await checkDatabaseHealth();
  res.json({
    status: dbHealthy ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    database: dbHealthy ? "connected" : "disconnected",
    version: "1.0.0",
  });
});

/**
 * Get Database Schema (for debugging/frontend introspection)
 */
app.get("/api/schema", async (_req, res) => {
  try {
    const schema = await getSchemaContext();
    res.json({
      success: true,
      tables: schema.tables.map((t) => ({
        name: t.tableName,
        columns: t.columns.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === "YES",
        })),
      })),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to load schema",
    });
  }
});

/**
 * Refresh schema cache
 */
app.post("/api/schema/refresh", async (_req, res) => {
  clearSchemaCache();
  try {
    await getSchemaContext();
    res.json({ success: true, message: "Schema cache refreshed" });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to refresh schema",
    });
  }
});

/**
 * Main Query Endpoint
 */
app.post("/api/query", async (req, res) => {
  const startTime = Date.now();

  // Validate request
  const body = req.body as QueryRequest;
  if (
    !body.query ||
    typeof body.query !== "string" ||
    body.query.trim() === ""
  ) {
    res.status(400).json({
      success: false,
      error: "Missing or empty 'query' field in request body",
    } as QueryResponse);
    return;
  }

  const query = body.query.trim();
  const tenantId = (body.tenantId || "").trim();

  if (!tenantId) {
    res.status(400).json({
      success: false,
      error:
        "Missing 'tenantId' field in request body. This is required to scope queries to your Xero organisation.",
    } as QueryResponse);
    return;
  }

  console.log(`\n📨 Incoming query: "${query}" [tenant: ${tenantId}]`);

  try {
    const { widgets, error } = await processQuery(query, tenantId);

    const response: QueryResponse = {
      success: !error,
      query,
      widgets,
      executionTimeMs: Date.now() - startTime,
      error: error || undefined,
    };

    res.json(response);
  } catch (err) {
    console.error("Query processing error:", err);

    const response: QueryResponse = {
      success: false,
      query,
      widgets: [],
      executionTimeMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : "Internal server error",
    };

    res.status(500).json(response);
  }
});

// ─── Global Error Handler ────────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  },
);

// ─── Start Server ────────────────────────────────────────────────────────────

const server = app.listen(config.port, () => {
  console.log(`
    ╔══════════════════════════════════════════════════╗
    ║         Text-to-SQL & Visualization API          ║
    ╠══════════════════════════════════════════════════╣
    ║  🚀 Server running on port ${String(config.port).padEnd(21)}║
    ║  📊 POST /api/query     → Process a query       ║
    ║  ❤️  GET  /api/health    → Health check           ║
    ║  🗄️  GET  /api/schema    → View DB schema         ║
    ╚══════════════════════════════════════════════════╝
  `);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown() {
  console.log("\n🛑 Shutting down gracefully...");
  server.close();
  await closePool();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
