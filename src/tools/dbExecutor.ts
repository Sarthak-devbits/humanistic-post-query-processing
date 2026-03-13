import { executeQuery } from "../config/database.js";

// ─── Safety: Block Dangerous SQL ─────────────────────────────────────────────

const BLOCKED_KEYWORDS = [
  "DROP",
  "DELETE",
  "TRUNCATE",
  "ALTER",
  "INSERT",
  "UPDATE",
  "CREATE",
  "GRANT",
  "REVOKE",
];

function validateSQL(sql: string): { safe: boolean; reason?: string } {
  const upperSQL = sql.toUpperCase().trim();

  for (const keyword of BLOCKED_KEYWORDS) {
    // Match keyword at word boundary to avoid false positives
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(upperSQL)) {
      return {
        safe: false,
        reason: `SQL contains blocked keyword: ${keyword}. Only SELECT queries are allowed.`,
      };
    }
  }

  if (!upperSQL.startsWith("SELECT") && !upperSQL.startsWith("WITH")) {
    return {
      safe: false,
      reason: "SQL must start with SELECT or WITH (CTE). No mutations allowed.",
    };
  }

  return { safe: true };
}

// ─── Execute SQL with Safety ─────────────────────────────────────────────────

export interface SQLExecutionResult {
  success: boolean;
  data: Record<string, unknown>[];
  rowCount: number;
  error?: string;
}

export async function executeSafeSQL(sql: string): Promise<SQLExecutionResult> {
  // Step 1: Validate
  console.log("Executing SQL")
  const validation = validateSQL(sql);
  if (!validation.safe) {
    return {
      success: false,
      data: [],
      rowCount: 0,
      error: validation.reason,
    };
  }

  // Step 2: Execute with timeout
  try {
    // Set timeout and run query separately — combining them causes pg
    // to return an array of Results (SET result + SELECT result)
    await executeQuery("SET statement_timeout = '30s'");
    const data = await executeQuery(sql);
    return {
      success: true,
      data,
      rowCount: data?.length || 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      data: [],
      rowCount: 0,
      error: `SQL execution error: ${message}`,
    };
  }
}
