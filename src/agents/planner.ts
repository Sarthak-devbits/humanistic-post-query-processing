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
    .enum(["data_query", "calculation", "comparison"])
    .describe(
      "data_query = needs SQL, calculation = needs math on existing data, comparison = compares results of other tasks",
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

const PLANNER_SYSTEM_PROMPT = `You are a financial query planner. Your job is to decompose a user's natural language question about their financial data into discrete, actionable sub-tasks.

CRITICAL Rules:
1. Generate AT MOST 5 sub-tasks. Fewer is better — combine related queries when possible.
2. STRONGLY PREFER "data_query" type. Let SQL do the heavy lifting (use CTEs, CASE, aggregations).
   - Instead of: task_1=fetch revenue, task_2=fetch expenses, task_3=calculate profit
   - Do: task_1=fetch revenue, expenses, and profit in ONE query using CTEs
3. Only use "calculation" if it genuinely cannot be done in SQL (e.g., forecasting, complex financial models).
4. Only use "comparison" if you need to compare results from two separate database queries.
5. Each data_query description must be SELF-CONTAINED — include all details needed to write SQL (time period, metrics, filters).
6. Do NOT create sub-tasks that depend on other sub-tasks unless absolutely necessary.
7. Keep descriptions specific to financial domain (revenue, expenses, profit, cash flow, etc).

Example:
  User: "What is the profit I had last 3 years and do I have enough money to sustain next 2 years for my crops?"
  → task_1: data_query — "Retrieve yearly revenue and expenses for the last 3 years"
  → task_2: data_query — "Retrieve current cash balance and average monthly expenses"
  → task_3: calculation — "Calculate profit per year from task_1 results"
  → task_4: calculation — "Calculate months of runway from task_2 results and check if >= 24 months"`;

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
