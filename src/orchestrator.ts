import { Annotation, StateGraph, END } from "@langchain/langgraph";
import { planQuery } from "./agents/planner.js";
import { selectSchema } from "./agents/schemaSelector.js";
import { generateSQL } from "./agents/sqlGenerator.js";
import { refineSQL } from "./agents/refiner.js";
import { generateWidgets } from "./agents/visualizer.js";
import { executeSafeSQL } from "./tools/dbExecutor.js";
import type {
  SubTask,
  SchemaContext,
  Widget,
  SubTaskResult,
  AIInsightWidget,
} from "./types/index.js";

// ─── State Definition ────────────────────────────────────────────────────────

const QueryStateAnnotation = Annotation.Root({
  query: Annotation<string>,
  tenantId: Annotation<string>, // Xero organisation ID
  subTasks: Annotation<SubTask[]>({
    reducer: (_, val) => val,
    default: () => [],
  }),
  currentTaskIndex: Annotation<number>({
    reducer: (_, val) => val,
    default: () => 0,
  }),
  schemaContext: Annotation<SchemaContext | null>({
    reducer: (_, val) => val,
    default: () => null,
  }),
  selectedSchemaText: Annotation<string>({
    reducer: (_, val) => val,
    default: () => "",
  }),
  currentSQL: Annotation<string>({
    reducer: (_, val) => val,
    default: () => "",
  }),
  sqlError: Annotation<string | null>({
    reducer: (_, val) => val,
    default: () => null,
  }),
  currentData: Annotation<Record<string, unknown>[]>({
    reducer: (_, val) => val,
    default: () => [],
  }),
  retryCount: Annotation<number>({
    reducer: (_, val) => val,
    default: () => 0,
  }),
  maxRetries: Annotation<number>({
    reducer: (_, val) => val,
    default: () => 3,
  }),
  results: Annotation<SubTaskResult[]>({
    reducer: (_, val) => val,
    default: () => [],
  }),
  failedTasks: Annotation<string[]>({
    reducer: (_, val) => val,
    default: () => [],
  }),
  widgets: Annotation<Widget[]>({
    reducer: (_, val) => val,
    default: () => [],
  }),
  error: Annotation<string | null>({
    reducer: (_, val) => val,
    default: () => null,
  }),
});

type QueryState = typeof QueryStateAnnotation.State;

// ─── Node: Plan ──────────────────────────────────────────────────────────────

async function planNode(state: QueryState): Promise<Partial<QueryState>> {
  console.log("🧠 [Planner] Decomposing query...");
  try {
    const { subTasks, reasoning } = await planQuery(state.query);
    console.log("SubTasks:");
    console.log(subTasks);
    console.log(`   → ${subTasks.length} sub-tasks identified`);
    return {
      subTasks,
      currentTaskIndex: 0,
      results: [],
    };
  } catch (err) {
    return {
      error: `Planner failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Node: Select Schema ────────────────────────────────────────────────────

async function selectSchemaNode(
  state: QueryState,
): Promise<Partial<QueryState>> {
  const task = state.subTasks[state.currentTaskIndex];
  if (!task) return { error: "No current sub-task found" };

  console.log(`🔍 [Schema Selector] Finding tables for: "${task.description}"`);
  try {
    const { tables, schemaContext } = await selectSchema(task.description);

    const selectedSchemaText = tables
      .map(
        (t) =>
          `TABLE: ${t.tableName}\n  Columns: ${t.columns.join(", ")}\n  Reason: ${t.reason}`,
      )
      .join("\n\n");

    console.log(`   → Selected ${tables.length} tables`);

    return {
      schemaContext,
      selectedSchemaText,
    };
  } catch (err) {
    return {
      error: `Schema selection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Node: Generate SQL ──────────────────────────────────────────────────────

async function generateSQLNode(
  state: QueryState,
): Promise<Partial<QueryState>> {
  const task = state.subTasks[state.currentTaskIndex];
  if (!task) return { error: "No current sub-task found" };

  console.log(`✍️  [SQL Generator] Writing query for: "${task.description}"`);
  try {
    // Inject the real tenantId into the task description so the LLM
    // uses the actual value instead of the '<tenantId>' placeholder.
    const taskWithTenant = `${task.description}\n\nIMPORTANT: The tenantId for this organisation is '${state.tenantId}'. Use this exact value in all WHERE clauses — do NOT use '<tenantId>' as a placeholder.`;

    const { sql, explanation } = await generateSQL(
      taskWithTenant,
      state.selectedSchemaText,
    );
    console.log(`   → Query: ${sql.substring(0, 100)}...`);
    console.log(`   → Explanation: ${explanation}`);
    return {
      currentSQL: sql,
      sqlError: null,
    };
  } catch (err) {
    return {
      error: `SQL generation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Node: Execute SQL ───────────────────────────────────────────────────────

async function executeSQLNode(state: QueryState): Promise<Partial<QueryState>> {
  const task = state.subTasks[state.currentTaskIndex];
  if (!task) return { error: "No current sub-task found" };

  console.log(`⚡ [DB Executor] Running query...`);
  console.log(state.currentSQL);
  const result = await executeSafeSQL(state.currentSQL);

  if (!result.success) {
    console.log(`   ❌ Error: ${result.error}`);
    return {
      sqlError: result.error || "Unknown SQL error",
      currentData: [],
    };
  }

  console.log(`   ✅ Got ${result.rowCount} rows`);
  console.log(result.data);
  return {
    currentData: result.data,
    sqlError: null,
  };
}

// ─── Node: Refine SQL ────────────────────────────────────────────────────────

async function refineSQLNode(state: QueryState): Promise<Partial<QueryState>> {
  console.log(
    `🔧 [Refiner] Fixing SQL (attempt ${state.retryCount + 1}/${state.maxRetries})...`,
  );
  try {
    const { sql, explanation } = await refineSQL(
      state.currentSQL,
      state.sqlError || "Unknown error",
      state.schemaContext?.raw || "",
    );
    console.log(`   → Fix: ${explanation}`);
    return {
      currentSQL: sql,
      sqlError: null,
      retryCount: state.retryCount + 1,
    };
  } catch (err) {
    console.log(
      `   ⚠️  Refiner failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(`   ⏭️  Skipping this sub-task, continuing with others...`);
    return {
      currentSQL: "",
      sqlError: null,
      currentData: [],
      retryCount: state.maxRetries, // Force exit the retry loop
    };
  }
}

// ─── Node: Collect Result & Move to Next Task ───────────────────────────────

async function collectResultNode(
  state: QueryState,
): Promise<Partial<QueryState>> {
  const task = state.subTasks[state.currentTaskIndex];
  if (!task) return {};

  const isFailed = state.currentData.length === 0 && task.type === "data_query";

  const result: SubTaskResult = {
    subTask: task,
    sql: state.currentSQL,
    data: state.currentData,
    widgets: [],
  };

  const updatedResults = [...state.results, result];
  const updatedFailed = isFailed
    ? [...state.failedTasks, task.description]
    : state.failedTasks;
  const nextIndex = state.currentTaskIndex + 1;

  console.log(
    `📦 [Collector] Task ${state.currentTaskIndex + 1}/${state.subTasks.length} ${isFailed ? "FAILED" : "done"}. Moving to next...`,
  );

  return {
    results: updatedResults,
    failedTasks: updatedFailed,
    currentTaskIndex: nextIndex,
    currentSQL: "",
    sqlError: null,
    currentData: [],
    retryCount: 0,
  };
}

// ─── Node: Visualize ─────────────────────────────────────────────────────────

async function visualizeNode(state: QueryState): Promise<Partial<QueryState>> {
  console.log(`🎨 [Visualizer] Designing widgets and attaching data...`);

  if (state.failedTasks.length > 0) {
    console.log(
      `   ⚠️  ${state.failedTasks.length} sub-task(s) failed — Visualizer will note missing data`,
    );
  }

  try {
    // Only pass sub-tasks that have data
    const successfulResults = state.results.filter((r) => r.data.length > 0);
    const descriptions = successfulResults.map((r) => r.subTask.description);
    const allData = successfulResults.map((r) => r.data);

    // Step 1: LLM designs widgets — returns field mappings + dataSourceIndex, NO raw data
    const widgetDesigns = await generateWidgets(
      state.query,
      descriptions,
      allData,
    );

    // Step 2: Attach the actual DB data rows using the LLM's dataSourceIndex.
    // The design object is now FLAT (no nested config), so we destructure
    // dataSourceIndex out and spread the rest as the widget's field mappings.
    const widgets: Widget[] = widgetDesigns.map((design) => {
      const { dataSourceIndex, ...widgetFields } = design;

      // For data-driven widgets, attach the rows from the referenced sub-task
      if (dataSourceIndex !== undefined && widgetFields.type !== "ai_insight") {
        const sourceResult = successfulResults[dataSourceIndex];
        if (sourceResult) {
          return {
            ...widgetFields, // type, title, xField, yFields, categoryField, etc.
            data: sourceResult.data,
          } as Widget;
        }
      }

      // ai_insight widgets have no data source
      return widgetFields as Widget;
    });

    // Step 3: Append a warning widget if any sub-tasks failed
    if (state.failedTasks.length > 0) {
      const warningWidget: AIInsightWidget = {
        type: "ai_insight",
        title: "Partial Results",
        text: `Could not retrieve data for: ${state.failedTasks.join(", ")}. The results shown are based on available data only.`,
        severity: "warning",
      };
      widgets.push(warningWidget);
    }

    console.log(
      `   → Generated ${widgets.length} widgets (with data attached)`,
    );
    return { widgets };
  } catch (err) {
    return {
      error: `Visualization failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Conditional Edges ───────────────────────────────────────────────────────

function afterPlan(state: QueryState): string {
  if (state.error) return END;
  if (state.subTasks.length === 0) return END;
  return "selectSchema";
}

function afterExecuteSQL(state: QueryState): string {
  // If there's already a fatal error, stop
  if (state.error) return END;

  // If SQL succeeded or task doesn't need SQL, collect result
  if (!state.sqlError) return "collectResult";

  // If error and retries remaining, refine
  if (state.retryCount < state.maxRetries) return "refineSQL";

  // Max retries exceeded — collect what we have and continue
  console.log(`   ⚠️  Max retries exceeded, moving forward with empty data`);
  return "collectResult";
}

function afterCollectResult(state: QueryState): string {
  if (state.error) return END;

  // More sub-tasks to process?
  if (state.currentTaskIndex < state.subTasks.length) {
    return "selectSchema";
  }

  // All sub-tasks done, generate visualizations
  return "visualize";
}

// ─── Build the Graph ─────────────────────────────────────────────────────────

function buildQueryGraph() {
  const graph = new StateGraph(QueryStateAnnotation)
    .addNode("plan", planNode)
    .addNode("selectSchema", selectSchemaNode)
    .addNode("generateSQL", generateSQLNode)
    .addNode("executeSQL", executeSQLNode)
    .addNode("refineSQL", refineSQLNode)
    .addNode("collectResult", collectResultNode)
    .addNode("visualize", visualizeNode)

    // Edges
    .addEdge("__start__", "plan")
    .addConditionalEdges("plan", afterPlan)
    .addEdge("selectSchema", "generateSQL")
    .addEdge("generateSQL", "executeSQL")
    .addConditionalEdges("executeSQL", afterExecuteSQL)
    .addEdge("refineSQL", "executeSQL") // Loop back after refinement
    .addConditionalEdges("collectResult", afterCollectResult)
    .addEdge("visualize", "__end__");

  return graph.compile();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function processQuery(
  query: string,
  tenantId: string,
): Promise<{ widgets: Widget[]; error: string | null }> {
  const app = buildQueryGraph();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`📝 Processing: "${query}" [tenant: ${tenantId}]`);
  console.log(`${"═".repeat(60)}\n`);

  const finalState = await app.invoke(
    {
      query,
      tenantId,
      maxRetries: 3,
    },
    {
      recursionLimit: 100,
    },
  );

  return {
    widgets: finalState.widgets,
    error: finalState.error,
  };
}
