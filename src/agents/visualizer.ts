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

## Widget Selection Rules
- Single KPI number → metric_card (set: valueField, aggregation, color)
- Time-series trend → line_chart (set: xField=date column, yFields=[value columns], xLabel, yLabel)
- Part-of-whole → donut_chart (set: labelField, valueField)
- Category comparison → bar_chart (set: categoryField, valueFields, xLabel, yLabel)
- Progress vs target → gauge (set: valueField, aggregation, min, max, unit, thresholds)
- Projected/actual trend → area_chart (set: xField, yFields, xLabel, yLabel)
- Raw rows → data_table (set: columns array with key=DB column name, label=header text)
- Text summary → ai_insight (set: text with markdown, severity)

## Rules
1. Field names (xField, categoryField, etc.) MUST exactly match column names from the sample data shown.
2. ALWAYS include ai_insight with a text summary and severity.
3. For ai_insight, do NOT set dataSourceIndex.
4. Return 3-12 widgets total.

## Colors: Revenue/Profit→green, Expenses/Loss→red, Neutral→blue, Warning→orange, Special→purple`;

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
