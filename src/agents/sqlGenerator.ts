import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "../config/index.js";
import type { GeneratedSQL } from "../types/index.js";

// ─── Load Prompt Files ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sqlRules = readFileSync(
  join(__dirname, "../prompts/sqlRules.md"),
  "utf-8",
);

const exactSchema = readFileSync(
  join(__dirname, "../prompts/exactSchema.md"),
  "utf-8",
);

// ─── Zod Schema ──────────────────────────────────────────────────────────────

const SQLOutputSchema = z.object({
  sql: z.string().describe("The complete PostgreSQL SELECT query"),
  explanation: z
    .string()
    .describe("Brief explanation of what this query does and why"),
});

// ─── System Prompt ───────────────────────────────────────────────────────────

const SQL_GENERATOR_PROMPT = `You are an expert PostgreSQL query writer for a Xero financial database.

${sqlRules}

---

## Database DDL Reference — Ground Truth

The following is the EXACT schema of the database. These are the precise table names and
column names (camelCase) as they exist in PostgreSQL. You MUST use these exact names,
always wrapped in double quotes. Do NOT use snake_case. Do NOT invent columns.

${exactSchema}

---

## Relevant Tables for This Query

The following subset of tables and columns is most relevant to the current query.
Use these as a guide for which tables to focus on, but rely on the DDL above
for exact column names and types:

{selectedSchema}

## Final Instructions

- Write ONLY a single SELECT query (or WITH + SELECT for CTEs).
- Use the EXACT column names from the DDL Reference above, wrapped in double quotes.
- Do NOT use tables or columns not listed in the DDL.
- Always include "tenantId" filtering in the WHERE clause.
- Always filter invoices by "status" IN ('AUTHORISED', 'PAID') for financial analysis.
- Round monetary values to 2 decimal places using ROUND(..., 2).
- Always include date filtering when the task mentions a time period.`;

// ─── SQL Generator Agent ─────────────────────────────────────────────────────

export async function generateSQL(
  taskDescription: string,
  selectedSchema: string,
): Promise<GeneratedSQL> {
  const llm = new ChatOpenAI({
    model: config.llmModelPrimary,
    temperature: 0,
    apiKey: config.openaiApiKey,
  });
  console.log("Task.........")
  console.log(taskDescription)

  const structuredLLM = llm.withStructuredOutput(SQLOutputSchema);

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", SQL_GENERATOR_PROMPT],
    ["human", "Write a PostgreSQL query for this task:\n\n{taskDescription}"],
  ]);

  const chain = prompt.pipe(structuredLLM);
  const result = await chain.invoke({
    taskDescription,
    selectedSchema,
  });

  return result as GeneratedSQL;
}
