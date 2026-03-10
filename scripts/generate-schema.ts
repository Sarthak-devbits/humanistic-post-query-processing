/**
 * Schema Generator Script
 *
 * Connects to your PostgreSQL database and generates a starter
 * schema_descriptions.yaml with all tables and columns discovered
 * from information_schema. You then fill in the description fields.
 *
 * Usage: npx tsx scripts/generate-schema.ts
 */

import pg from "pg";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
}

interface ForeignKeyRow {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL not set in .env");
    process.exit(1);
  }

  console.log("🔌 Connecting to database...");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Discover all columns
    const columnsResult = await pool.query<ColumnRow>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    // Discover foreign keys
    const fkResult = await pool.query<ForeignKeyRow>(`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    `);

    // Discover primary keys
    const pkResult = await pool.query<{
      table_name: string;
      column_name: string;
    }>(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
    `);

    // Build lookup maps
    const pkMap = new Set(
      pkResult.rows.map((r) => `${r.table_name}.${r.column_name}`),
    );
    const fkMap = new Map<string, ForeignKeyRow>();
    for (const fk of fkResult.rows) {
      fkMap.set(`${fk.table_name}.${fk.column_name}`, fk);
    }

    // Group columns by table
    const tableMap = new Map<string, ColumnRow[]>();
    for (const col of columnsResult.rows) {
      const existing = tableMap.get(col.table_name) || [];
      existing.push(col);
      tableMap.set(col.table_name, existing);
    }

    console.log(`📋 Found ${tableMap.size} tables\n`);

    // Generate YAML
    let yaml = `# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  AUTO-GENERATED SCHEMA DESCRIPTIONS                                        │
# │  Generated: ${new Date().toISOString().padEnd(56)}│
# │                                                                            │
# │  Fill in the "description" and "business_context" fields for each table    │
# │  and column. The AI agents use this to write accurate SQL queries.         │
# └─────────────────────────────────────────────────────────────────────────────┘

tables:
`;

    for (const [tableName, columns] of tableMap) {
      yaml += `\n  - name: ${tableName}\n`;
      yaml += `    description: "TODO: Describe what this table stores"\n`;
      yaml += `    business_context: "TODO: How is this table used in financial analysis?"\n`;
      yaml += `    columns:\n`;

      for (const col of columns) {
        const key = `${tableName}.${col.column_name}`;
        const isPK = pkMap.has(key);
        const fk = fkMap.get(key);

        yaml += `      - name: ${col.column_name}\n`;
        yaml += `        type: ${col.data_type}\n`;
        yaml += `        description: "TODO: What does this column store?"\n`;

        if (isPK) {
          yaml += `        role: primary_key\n`;
        } else if (fk) {
          yaml += `        role: foreign_key\n`;
          yaml += `        references: "${fk.foreign_table_name}.${fk.foreign_column_name}"\n`;
        }

        if (col.is_nullable === "NO" && !isPK) {
          yaml += `        required: true\n`;
        }
      }

      // Add relationships
      const tableFKs = fkResult.rows.filter(
        (fk) => fk.table_name === tableName,
      );
      if (tableFKs.length > 0) {
        yaml += `    relationships:\n`;
        for (const fk of tableFKs) {
          yaml += `      - from: ${fk.table_name}.${fk.column_name}\n`;
          yaml += `        to: ${fk.foreign_table_name}.${fk.foreign_column_name}\n`;
          yaml += `        type: many_to_one\n`;
          yaml += `        description: "TODO: Describe this relationship"\n`;
        }
      }

      console.log(`  ✅ ${tableName} (${columns.length} columns)`);
    }

    // Write to file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const outputPath = join(
      __dirname,
      "../src/prompts/schema_descriptions.yaml",
    );

    writeFileSync(outputPath, yaml, "utf-8");
    console.log(`\n📝 Written to: ${outputPath}`);
    console.log(
      `\n⚡ Next step: Open the file and fill in the TODO descriptions!`,
    );
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
