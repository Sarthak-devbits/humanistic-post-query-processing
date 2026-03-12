import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "../config/index.js";
import type { GeneratedSQL } from "../types/index.js";

// ─── Load SQL Rules ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sqlRules = readFileSync(
  join(__dirname, "../prompts/sqlRules.md"),
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

const SQL_GENERATOR_PROMPT = `You are an expert PostgreSQL query writer for a financial database.

${sqlRules}

## Relevant Schema
The following tables and columns are available for this specific query:
{selectedSchema}

## Important
- Write ONLY a single SELECT query (or WITH + SELECT for CTEs).
- Use the exact table and column names from the schema above.
- Do NOT use tables or columns that are not listed above.
- Always include date filtering when the task mentions a time period.
- Round monetary values to 2 decimal places.`;

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
