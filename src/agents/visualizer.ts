import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "../config/index.js";

// ─── Load Widget Schema ──────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const widgetSchemaJSON = readFileSync(
  join(__dirname, "../prompts/widgetSchema.json"),
  "utf-8",
);

// ─── Zod Schema ──────────────────────────────────────────────────────────────
// ALL field mappings are at the TOP LEVEL — no nested "config" wrapper.
// This ensures the LLM fills in each field explicitly with full type guidance.

const WidgetOutputSchema = z.object({
  widgets: z.array(
    z.object({
      // ── Common ─────────────────────────────────────────────────────────────
      type: z.enum([
        "metric_card",
        "line_chart",
        "gauge",
        "bar_chart",
        "donut_chart",
        "area_chart",
        "data_table",
        "ai_insight",
      ]),
      title: z.string(),
      dataSourceIndex: z
        .number()
        .optional()
        .describe(
          "0-based index of the sub-task whose data to use. Not needed for ai_insight.",
        ),

      // ── metric_card & gauge ─────────────────────────────────────────────────
      valueField: z
        .string()
        .optional()
        .describe("DB column name for the main value (metric_card, gauge)"),
      aggregation: z
        .enum(["sum", "avg", "count", "min", "max", "first"])
        .optional()
        .describe(
          "How to aggregate valueField across all rows (metric_card, gauge)",
        ),
      unit: z.string().optional().describe("Display unit e.g. USD, %, months"),
      trend: z.enum(["up", "down", "flat"]).optional(),
      trendValue: z.string().optional().describe("e.g. '+12% vs last year'"),
      color: z
        .enum(["green", "red", "blue", "orange", "purple"])
        .optional()
        .describe("Required for metric_card"),
      min: z.number().optional().describe("Gauge min value"),
      max: z.number().optional().describe("Gauge max value"),
      thresholds: z
        .array(
          z.object({
            value: z.number(),
            color: z.string(),
            label: z.string(),
          }),
        )
        .optional()
        .describe("Gauge thresholds"),

      // ── line_chart & area_chart ─────────────────────────────────────────────
      xField: z
        .string()
        .optional()
        .describe("DB column for X axis (date/time column for trends)"),
      yFields: z
        .array(z.string())
        .optional()
        .describe("DB column(s) for Y axis lines/areas"),
      xLabel: z.string().optional().describe("X axis label"),
      yLabel: z.string().optional().describe("Y axis label"),

      // ── bar_chart ───────────────────────────────────────────────────────────
      categoryField: z
        .string()
        .optional()
        .describe("DB column for bar categories (X axis)"),
      valueFields: z
        .array(z.string())
        .optional()
        .describe("DB column(s) for bar values (Y axis)"),

      // ── donut_chart ─────────────────────────────────────────────────────────
      labelField: z
        .string()
        .optional()
        .describe("DB column for donut slice labels"),

      // ── data_table ──────────────────────────────────────────────────────────
      columns: z
        .array(
          z.object({
            key: z.string().describe("DB column name"),
            label: z.string().describe("Human-readable column header"),
            sortable: z.boolean().optional(),
          }),
        )
        .optional()
        .describe("Column definitions for data_table"),
      pageSize: z.number().optional(),

      // ── ai_insight ──────────────────────────────────────────────────────────
      text: z
        .string()
        .optional()
        .describe(
          "Markdown text with the AI summary (required for ai_insight)",
        ),
      severity: z
        .enum(["info", "success", "warning", "danger"])
        .optional()
        .describe("Required for ai_insight"),
    }),
  ),
});

// ─── LLM Widget Design Type ──────────────────────────────────────────────────

export type WidgetDesign = z.infer<
  typeof WidgetOutputSchema
>["widgets"][number];

// ─── System Prompt ───────────────────────────────────────────────────────────

const VISUALIZER_PROMPT = `You are a data visualization expert. Your job is to design dashboard widgets for financial data.

## Architecture
You return widget FIELD MAPPINGS (column names), not raw data arrays.
The backend will attach the actual database rows using your "dataSourceIndex".

## Sub-task Indices
Each sub-task has an index (0, 1, 2...). Use "dataSourceIndex" to tell the backend which sub-task's rows to attach.

## Available Widget Types and Fields
${widgetSchemaJSON}

## Widget Selection Rules — READ CAREFULLY

Use these rules to pick the BEST widget for each sub-task result. Always look at the data shape (number of rows, column types) AND the query intent.

### metric_card
- **When**: result is 1 row × 1-3 numeric columns, representing a single KPI
- **Examples**: Total Revenue, Total Outstanding AR, Net Profit, Total Invoice Count
- **Never use for**: percentages/ratios that have a natural 0-100 range → use gauge instead
- Fields: valueField (column name), aggregation="first" for pre-aggregated results or "sum" for multi-row

### gauge
- **When**: result contains a PERCENTAGE, RATIO, RATE, or metric with a natural bounded range
- **Xero use cases** — use gauge for ANY of these column names or concepts:
  - Collection rate / payment rate (0–100%)
  - Gross margin % / profit margin % (0–100%)
  - Quote win rate / conversion rate (0–100%)
  - DSO — Days Sales Outstanding (0–90 days is typical range; set max to 90)
  - DPO — Days Payable Outstanding (0–90 days)
  - Average days to pay (0–90 days)
  - Business runway in months (0–24 months; set max to 24)
  - Inventory turnover rate
- **Data shape**: 1 row, 1 numeric column that is a percentage or bounded number
- **Always set**: min, max, unit (e.g. "%", "days", "months"), and meaningful thresholds
- **Threshold guide**:
  - Collection rate thresholds: [{value:70,color:"red",label:"Poor"},{value:90,color:"orange",label:"OK"},{value:95,color:"green",label:"Good"}]
  - Gross margin thresholds: [{value:20,color:"red",label:"Low"},{value:40,color:"orange",label:"OK"},{value:60,color:"green",label:"Healthy"}]
  - DSO/days thresholds: [{value:30,color:"green",label:"Fast"},{value:60,color:"orange",label:"Slow"},{value:90,color:"red",label:"Critical"}]
  - Win rate thresholds: [{value:25,color:"red",label:"Low"},{value:50,color:"orange",label:"OK"},{value:75,color:"green",label:"Strong"}]
- **Never use for**: absolute dollar amounts → use metric_card

### donut_chart
- **When**: result has 2–4 rows, one text label column, one numeric value column, and the values represent shares of a whole
- **Xero use cases** — use donut_chart for ANY of these:
  - Revenue or spend breakdown by customer/supplier (top customers, top suppliers)
  - Expense distribution across suppliers
  - Revenue share by product/item
  - Invoice status distribution (Authorised vs Paid vs Overdue)
  - Cash flow split (cash in vs cash out)
  - AR aging bucket totals (Current / 1-30 / 31-60 / 90+)
- **Query keywords that trigger donut**: "breakdown", "distribution", "share", "percentage of", "by customer", "by supplier", "by category", "split", "proportion"
- **Data shape signal**: if result has < 5 rows with a name column + a value column → PREFER donut_chart over bar_chart
- Fields: labelField (text column name), valueField (numeric column name)

### bar_chart
- **When**: comparing discrete categories where seeing exact magnitudes side-by-side matters, OR result has > 10 categories, OR showing multiple value series per category (grouped bars)
- **Prefer bar over donut when**: > 10 categories, or showing revenue + expenses side by side per month
- **Xero use cases**: Monthly P&L (revenue vs expenses per month), top N customers with invoice count + revenue together

### line_chart
- **When**: data has a date/time column and the question asks about trends over time
- **xField must be a date column** (month, date, period)
- **Xero use cases**: Revenue by month, MoM growth trend, cash flow over time

### data_table
- **When**: result has > 10 rows, or multiple mixed columns (dates + names + numbers), or the user needs to scroll/search
- **Xero use cases**: Unpaid invoice list, overdue AR detail, all transactions in a period

### ai_insight
- **Always include** exactly one ai_insight widget summarising the data with key observations, anomalies, or financial interpretation
- Write 2-4 sentences of real analytical value — not just restating the numbers

## Conflict Resolution

| Situation | Choose |
|---|---|
| < 5 rows, 1 label + 1 value column | **donut_chart** (not bar_chart) |
| ≥ 5 rows, 1 label + 1 value column | **bar_chart** |
| 2+ value columns per category | **bar_chart** |
| 1 row, $ amount | **metric_card** |
| 1 row, % or rate or days | **gauge** |
| Has date column + trend intent | **line_chart** |

## Rules
1. Field names MUST exactly match column names from the sample data shown.
2. ALWAYS include exactly one ai_insight.
3. For ai_insight, do NOT set dataSourceIndex.
4. Return 2–8 widgets total.
5. **Before defaulting to bar_chart**: check if donut_chart fits (< 5 rows, proportion data).
6. **Before defaulting to metric_card**: check if gauge fits (percentage, rate, or bounded metric).

## Colors: Revenue/Profit/Positive→green, Expenses/Loss/Negative→red, Neutral/Info→blue, Warning/Overdue→orange, Special→purple`;

// ─── Visualizer Agent ────────────────────────────────────────────────────────

export async function generateWidgets(
  userQuery: string,
  subTaskDescriptions: string[],
  queryResults: Record<string, unknown>[][],
): Promise<WidgetDesign[]> {
  const llm = new ChatOpenAI({
    model: config.llmModelPrimary,
    temperature: 0.1,
    apiKey: config.openaiApiKey,
    timeout: 60_000,
  });

  const structuredLLM = llm.withStructuredOutput(WidgetOutputSchema);

  // Send only the first row per sub-task so LLM knows exact column names
  const dataContext = subTaskDescriptions
    .map((desc, i) => {
      const data = queryResults[i] || [];
      const sample =
        data.length > 0
          ? JSON.stringify(data[0], null, 2)
          : "(no data — sub-task failed)";
      return `Sub-task ${i} (dataSourceIndex: ${i}): ${desc}\nExample row (use exact column names):\n${sample}\nTotal rows: ${data.length}`;
    })
    .join("\n\n---\n\n");

  const messages = [
    new SystemMessage(VISUALIZER_PROMPT),
    new HumanMessage(
      `User Question: ${userQuery}\n\nSub-task data:\n\n${dataContext}\n\nDesign the best visualization widgets using exact column names from the sample rows above.`,
    ),
  ];

  console.log("⏳ [Visualizer] Calling LLM...");

  const result = await structuredLLM.invoke(messages);

  console.log(`   → ${result.widgets.length} widgets designed`);

  return result.widgets;
}
