import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import YAML from "yaml";
import { config } from "./index.js";
import type { ColumnInfo, TableSchema, SchemaContext } from "../types/index.js";

const { Pool } = pg;

// ─── Load YAML Schema Descriptions ───────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface YAMLColumn {
  name: string;
  type: string;
  description: string;
  role?: string;
  references?: string;
  required?: boolean;
  examples?: string[];
}

interface YAMLRelationship {
  from: string;
  to: string;
  type: string;
  description: string;
}

interface YAMLSampleQuery {
  description: string;
  sql: string;
}

interface YAMLTable {
  name: string;
  description: string;
  business_context?: string;
  columns: YAMLColumn[];
  relationships?: YAMLRelationship[];
  sample_queries?: YAMLSampleQuery[];
}

interface YAMLSchema {
  tables: YAMLTable[];
}

function loadSchemaDescriptions(): YAMLSchema | null {
  try {
    const yamlPath = join(__dirname, "../prompts/schema_descriptions.yaml");
    const content = readFileSync(yamlPath, "utf-8");
    return YAML.parse(content) as YAMLSchema;
  } catch (err) {
    console.warn(
      "⚠️  Could not load schema_descriptions.yaml, falling back to information_schema only.",
    );
    return null;
  }
}

// ─── Connection Pool ─────────────────────────────────────────────────────────

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on("error", (err) => {
      console.error("Unexpected database pool error:", err);
    });
  }
  return pool;
}

// ─── Query Execution ─────────────────────────────────────────────────────────

export async function executeQuery(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const p = getPool();
  const result = await p.query(sql, params);
  return result.rows as Record<string, unknown>[];
}

// ─── Health Check ────────────────────────────────────────────────────────────

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const p = getPool();
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ─── Schema Discovery (Enriched with YAML Descriptions) ─────────────────────

export async function loadSchemaMetadata(): Promise<SchemaContext> {
  const p = getPool();

  // Step 1: Auto-discover from information_schema
  const result = await p.query<ColumnInfo>(`
    SELECT
      table_name,
      table_schema,
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);


  const tableMap = new Map<string, ColumnInfo[]>();
  for (const col of result.rows) {
    const existing = tableMap.get(col.table_name) || [];
    existing.push(col);
    tableMap.set(col.table_name, existing);
  }

  const tables: TableSchema[] = Array.from(tableMap.entries()).map(
    ([tableName, columns]) => ({
      tableName,
      columns,
    }),
  );

  // Step 2: Load developer descriptions from YAML
  const yamlSchema = loadSchemaDescriptions();
  const yamlTableMap = new Map<string, YAMLTable>();
  if (yamlSchema) {
    for (const t of yamlSchema.tables) {
      yamlTableMap.set(t.name, t);
    }
  }

  // Step 3: Build enriched human-readable schema string
  const raw = tables
    .map((t) => {
      const yamlTable = yamlTableMap.get(t.tableName);

      // Table header with description
      let section = `TABLE: ${t.tableName}`;
      if (yamlTable?.description) {
        section += `\n  Description: ${yamlTable.description.trim()}`;
      }
      if (yamlTable?.business_context) {
        section += `\n  Business Context: ${yamlTable.business_context.trim()}`;
      }

      // Columns with enriched descriptions
      section += `\n  Columns:`;
      const yamlColMap = new Map<string, YAMLColumn>();
      if (yamlTable) {
        for (const c of yamlTable.columns) {
          yamlColMap.set(c.name, c);
        }
      }

      for (const col of t.columns) {
        const yamlCol = yamlColMap.get(col.column_name);
        let line = `    - ${col.column_name} (${col.data_type}`;
        if (col.is_nullable === "YES") line += ", nullable";
        line += ")";

        if (yamlCol?.role) line += ` [${yamlCol.role}]`;
        if (yamlCol?.references) line += ` → ${yamlCol.references}`;
        if (yamlCol?.description && !yamlCol.description.startsWith("TODO")) {
          line += ` — ${yamlCol.description.trim()}`;
        }
        if (yamlCol?.examples) {
          line += ` (examples: ${yamlCol.examples.join(", ")})`;
        }

        section += `\n${line}`;
      }

      // Relationships
      if (yamlTable?.relationships?.length) {
        section += `\n  Relationships:`;
        for (const rel of yamlTable.relationships) {
          section += `\n    - ${rel.from} → ${rel.to} (${rel.type})`;
          if (rel.description && !rel.description.startsWith("TODO")) {
            section += ` — ${rel.description}`;
          }
        }
      }

      // Sample queries
      if (yamlTable?.sample_queries?.length) {
        section += `\n  Sample Queries:`;
        for (const sq of yamlTable.sample_queries) {
          section += `\n    - ${sq.description}: ${sq.sql}`;
        }
      }

      return section;
    })
    .join("\n\n");
    console.log(raw)
  return { tables, raw };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
