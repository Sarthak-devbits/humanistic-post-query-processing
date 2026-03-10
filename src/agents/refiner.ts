import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { config } from "../config/index.js";

// ─── Zod Schema ──────────────────────────────────────────────────────────────

const RefinedSQLSchema = z.object({
  sql: z.string().describe("The corrected PostgreSQL SELECT query"),
  explanation: z.string().describe("What was wrong and how it was fixed"),
});

// ─── System Prompt ───────────────────────────────────────────────────────────

const REFINER_PROMPT = `You are a PostgreSQL debugging expert. A SQL query was generated but failed to execute.

Your job is to:
1. Analyze the error message from PostgreSQL.
2. Identify the root cause (typo, wrong column name, syntax error, wrong table, etc).
3. Fix the SQL query so it executes successfully.
4. Preserve the original intent of the query.

## Available Schema
{schema}

## Rules
- Only return SELECT queries (no INSERT, UPDATE, DELETE, etc).
- Use the exact column and table names from the schema above.
- If a column doesn't exist, find the closest matching column.
- Keep the query structure as close to the original as possible.`;

// ─── Refiner Agent ───────────────────────────────────────────────────────────

export async function refineSQL(
  originalSQL: string,
  errorMessage: string,
  schema: string,
): Promise<{ sql: string; explanation: string }> {
  const llm = new ChatOpenAI({
    model: config.llmModelPrimary,
    temperature: 0,
    apiKey: config.openaiApiKey,
  });

  const structuredLLM = llm.withStructuredOutput(RefinedSQLSchema);

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", REFINER_PROMPT],
    [
      "human",
      `The following SQL query failed:

      \`\`\`sql
      {originalSQL}
      \`\`\`

      PostgreSQL Error:
      {errorMessage}

      Please fix the query.`,
    ],
  ]);

  const chain = prompt.pipe(structuredLLM);
  const result = await chain.invoke({
    originalSQL,
    errorMessage,
    schema,
  });

  return result;
}
