import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { config } from "../config/index.js";
import { loadSchemaMetadata } from "../config/database.js";
import type { SchemaContext } from "../types/index.js";

// ─── Zod Schema ──────────────────────────────────────────────────────────────

const SelectedSchemaSchema = z.object({
  tables: z.array(
    z.object({
      tableName: z.string(),
      columns: z
        .array(z.string())
        .describe("Only the relevant column names for this sub-task"),
      reason: z.string().describe("Why this table/columns are needed"),
    }),
  ),
});

// ─── System Prompt ───────────────────────────────────────────────────────────

const SCHEMA_SELECTOR_PROMPT = `You are a database schema expert. Given a sub-task description and the full database schema, select ONLY the tables and columns that are relevant for generating a SQL query for this sub-task.

Rules:
1. Be selective — only include tables and columns that are directly needed.
2. Include primary keys and foreign keys if JOINs will be required.
3. Include date/timestamp columns needed for time-based filtering.
4. Include the "reason" explaining why each table is relevant.
5. If no tables seem relevant, still return your best guess based on column names.

Database Schema:
{schema}`;

// ─── Schema Cache ────────────────────────────────────────────────────────────

let cachedSchema: SchemaContext | null = null;

export async function getSchemaContext(): Promise<SchemaContext> {
  if (!cachedSchema) {
    cachedSchema = await loadSchemaMetadata();
  }
  return cachedSchema;
}

export function clearSchemaCache(): void {
  cachedSchema = null;
}

// ─── Schema Selector Agent ──────────────────────────────────────────────────

export async function selectSchema(taskDescription: string): Promise<{
  tables: { tableName: string; columns: string[]; reason: string }[];
  schemaContext: SchemaContext;
}> {
  const schemaContext = await getSchemaContext();
  const llm = new ChatOpenAI({
    model: config.llmModelFast,
    temperature: 0,
    apiKey: config.openaiApiKey,
  });

  const structuredLLM = llm.withStructuredOutput(SelectedSchemaSchema);

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", SCHEMA_SELECTOR_PROMPT],
    [
      "human",
      "Select the relevant tables and columns for this sub-task:\n\n{taskDescription}",
    ],
  ]);

  const chain = prompt.pipe(structuredLLM);
  const result = await chain.invoke({
    schema: schemaContext.raw,
    taskDescription,
  });

  return {
    tables: result.tables,
    schemaContext,
  };
}
