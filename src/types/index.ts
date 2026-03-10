// ─── Sub-Task (Planner Output) ───────────────────────────────────────────────

export interface SubTask {
  id: string;
  description: string;
  dependsOn: string[];
  type: "data_query" | "calculation" | "comparison";
}

// ─── Schema Metadata ─────────────────────────────────────────────────────────

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  table_name: string;
  table_schema: string;
}

export interface TableSchema {
  tableName: string;
  columns: ColumnInfo[];
}

export interface SchemaContext {
  tables: TableSchema[];
  raw: string; // Formatted text for injection into prompts
}

// ─── SQL Generation ──────────────────────────────────────────────────────────

export interface GeneratedSQL {
  sql: string;
  explanation: string;
}

// ─── Widget Types ────────────────────────────────────────────────────────────
// Each widget has a `dataMapping` that tells the frontend which DB fields to use,
// and a `data` array containing the actual rows from the database.

export interface MetricCardWidget {
  type: "metric_card";
  title: string;
  valueField: string; // DB column name to display as the main value
  aggregation: "sum" | "avg" | "count" | "min" | "max" | "first";
  unit?: string;
  trend?: "up" | "down" | "flat";
  trendValue?: string;
  color: "green" | "red" | "blue" | "orange" | "purple";
  data: Record<string, unknown>[];
}

export interface LineChartWidget {
  type: "line_chart";
  title: string;
  xField: string; // DB column for X axis
  yFields: string[]; // DB column(s) for Y axis (multiple lines)
  xLabel: string;
  yLabel: string;
  data: Record<string, unknown>[];
}

export interface GaugeWidget {
  type: "gauge";
  title: string;
  valueField: string; // DB column to display
  aggregation: "sum" | "avg" | "count" | "min" | "max" | "first";
  min: number;
  max: number;
  unit: string;
  thresholds: { value: number; color: string; label: string }[];
  data: Record<string, unknown>[];
}

export interface BarChartWidget {
  type: "bar_chart";
  title: string;
  categoryField: string; // DB column for categories (X axis)
  valueFields: string[]; // DB column(s) for values (Y axis, grouped bars)
  xLabel: string;
  yLabel: string;
  data: Record<string, unknown>[];
}

export interface DonutChartWidget {
  type: "donut_chart";
  title: string;
  labelField: string; // DB column for slice labels
  valueField: string; // DB column for slice values
  data: Record<string, unknown>[];
}

export interface AreaChartWidget {
  type: "area_chart";
  title: string;
  xField: string; // DB column for X axis
  yFields: string[]; // DB column(s) for Y axis areas
  xLabel: string;
  yLabel: string;
  data: Record<string, unknown>[];
}

export interface DataTableWidget {
  type: "data_table";
  title: string;
  columns: { key: string; label: string; sortable?: boolean }[];
  pageSize?: number;
  data: Record<string, unknown>[];
}

export interface AIInsightWidget {
  type: "ai_insight";
  title: string;
  text: string; // Markdown-supported text
  severity: "info" | "success" | "warning" | "danger";
}

export type Widget =
  | MetricCardWidget
  | LineChartWidget
  | GaugeWidget
  | BarChartWidget
  | DonutChartWidget
  | AreaChartWidget
  | DataTableWidget
  | AIInsightWidget;

// ─── Orchestrator State ──────────────────────────────────────────────────────

export interface SubTaskResult {
  subTask: SubTask;
  sql: string;
  data: Record<string, unknown>[];
  widgets: Widget[];
}

export interface QueryState {
  query: string;
  subTasks: SubTask[];
  currentTaskIndex: number;
  schemaContext: SchemaContext | null;
  currentSQL: string;
  sqlError: string | null;
  currentData: Record<string, unknown>[];
  retryCount: number;
  maxRetries: number;
  results: SubTaskResult[];
  widgets: Widget[];
  error: string | null;
}

// ─── API Types ───────────────────────────────────────────────────────────────

export interface QueryRequest {
  query: string;
}

export interface QueryResponse {
  success: boolean;
  query: string;
  widgets: Widget[];
  executionTimeMs: number;
  error?: string;
}
