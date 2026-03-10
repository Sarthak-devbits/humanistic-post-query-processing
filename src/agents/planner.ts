import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { config } from "../config/index.js";
import type { SubTask } from "../types/index.js";

// ─── Zod Schema for Structured Output ────────────────────────────────────────

const SubTaskSchema = z.object({
  id: z.string().describe("Unique identifier like 'task_1', 'task_2'"),
  description: z
    .string()
    .describe(
      "Clear description of what data this sub-task needs to retrieve or compute",
    ),
  dependsOn: z
    .array(z.string())
    .describe("IDs of sub-tasks that must complete before this one"),
  type: z
    .literal("data_query")
    .describe(
      "All tasks must be data_query — SQL handles all aggregations and calculations",
    ),
});

const PlannerOutputSchema = z.object({
  subTasks: z
    .array(SubTaskSchema)
    .describe("Ordered list of sub-tasks to answer the user query"),
  reasoning: z
    .string()
    .describe("Brief explanation of why this decomposition was chosen"),
});

// ─── System Prompt ───────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are a financial query planner. Your job is to decompose a user's natural language question into independent SQL sub-tasks.

CRITICAL Rules:
1. ALL tasks must be type "data_query". SQL handles everything — aggregations, calculations, comparisons, trends.
2. Generate AT MOST 5 sub-tasks. Fewer is better — combine related queries into ONE using CTEs.
   - Revenue + expenses + profit → one query with CTEs
   - Trend analysis → one query with DATE_TRUNC grouping
   - Comparisons → one query with CASE or self-join
3. Each sub-task must be SELF-CONTAINED and INDEPENDENT — it should not depend on another task's results.
4. NEVER create a sub-task to "summarize", "analyze", or "provide an insight" — the Visualizer handles this automatically.
5. Each description must include: what metric, what time period, what filters.

Example:
  User: "What is the profit I had last 3 years and which store performs better?"
  → task_1: data_query — "Retrieve yearly revenue, expenses, and net profit for the last 3 years using CTEs"
  → task_2: data_query — "Retrieve total revenue per store location grouped by store_id"

  NOT ALLOWED:
  ✗ task_3: calculation — any calculation task (SQL handles this)
  ✗ task_4: comparison — any comparison task (SQL handles this)
  ✗ task_5: any "summarize results" task (Visualizer handles this)`;

// ─── Planner Agent ───────────────────────────────────────────────────────────

export async function planQuery(userQuery: string): Promise<{
  subTasks: SubTask[];
  reasoning: string;
}> {
  const llm = new ChatOpenAI({
    model: config.llmModelPrimary,
    temperature: 0,
    apiKey: config.openaiApiKey,
  });

  const structuredLLM = llm.withStructuredOutput(PlannerOutputSchema);

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", PLANNER_SYSTEM_PROMPT],
    ["human", "Decompose this financial query into sub-tasks:\n\n{query}"],
  ]);

  const chain = prompt.pipe(structuredLLM);
  const result = await chain.invoke({ query: userQuery });

  return {
    subTasks: result.subTasks as SubTask[],
    reasoning: result.reasoning,
  };
}
