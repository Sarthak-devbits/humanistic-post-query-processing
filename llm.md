# LLM Project Context — Humanistic Post-Query Processing

This file gives a complete picture of the project so any LLM reading it can understand the architecture, all file responsibilities, and how to make changes correctly.

---

## What This Project Does

A **natural language → SQL → dashboard widget** API.

User sends a plain English financial question (e.g. _"Show me monthly revenue trends and top customers by spending"_). The system:

1. Decomposes it into independent SQL sub-tasks
2. Selects relevant DB schema for each sub-task
3. Generates PostgreSQL queries
4. Executes them, retrying with LLM-based refinement on error
5. Maps results to dashboard widgets with field mappings + raw data
6. Returns JSON that a frontend can directly render as charts/tables

---

## Tech Stack

| Layer             | Technology                                     |
| ----------------- | ---------------------------------------------- |
| Runtime           | Node.js + TypeScript (ESM modules)             |
| Web server        | Express.js                                     |
| LLM orchestration | LangChain + LangGraph (`@langchain/langgraph`) |
| LLM provider      | OpenAI (configurable via env)                  |
| Database          | PostgreSQL (via `pg` pool)                     |
| Schema validation | Zod (structured LLM output)                    |
| Package manager   | npm (lockfile: `package-lock.json`)            |

---

## Project Structure

```
humanistic/
├── src/
│   ├── app.ts                    # Express server, routes, startup
│   ├── orchestrator.ts           # LangGraph state machine — the core pipeline
│   ├── agents/
│   │   ├── planner.ts            # Decomposes query into sub-tasks
│   │   ├── schemaSelector.ts     # Picks relevant tables/columns per sub-task
│   │   ├── sqlGenerator.ts       # Writes PostgreSQL queries
│   │   ├── refiner.ts            # Fixes broken SQL on execution error
│   │   └── visualizer.ts        # Designs dashboard widgets with field mappings
│   ├── tools/
│   │   └── dbExecutor.ts         # SQL safety validator + pg execution wrapper
│   ├── config/
│   │   ├── index.ts              # Env var config object
│   │   └── database.ts           # pg pool, executeQuery, loadSchemaMetadata (+ YAML enrichment)
│   ├── types/
│   │   └── index.ts              # All TypeScript interfaces (Widget types, SubTask, etc.)
│   └── prompts/
│       ├── sqlRules.md           # Injected into SQL Generator prompt (PostgreSQL rules)
│       ├── widgetSchema.json     # Widget type contract given to Visualizer LLM
│       └── schema_descriptions.yaml  # Developer-written table/column descriptions
├── scripts/
│   └── generate-schema.ts       # CLI tool to scaffold schema_descriptions.yaml from DB
├── .env                          # DATABASE_URL, OPENAI_API_KEY, etc.
└── llm.md                        # This file
```

---

## Environment Variables (`.env`)

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname
OPENAI_API_KEY=sk-...
LLM_MODEL_PRIMARY=gpt-4o          # Used for SQL gen, refinement, visualization
LLM_MODEL_FAST=gpt-4o-mini        # Used for schema selection (cheaper/faster)
PORT=3000
```

---

## API Endpoints (`src/app.ts`)

| Method | Path                  | Description                               |
| ------ | --------------------- | ----------------------------------------- |
| `POST` | `/api/query`          | Main endpoint. Body: `{ "query": "..." }` |
| `GET`  | `/api/health`         | Health check, DB connectivity             |
| `GET`  | `/api/schema`         | Returns full DB schema (for debugging)    |
| `POST` | `/api/schema/refresh` | Clears the in-memory schema cache         |

### `/api/query` Response Shape

```json
{
  "success": true,
  "query": "original user question",
  "widgets": [ ...widget objects... ],
  "executionTimeMs": 12400
}
```

---

## The Pipeline — LangGraph State Machine (`src/orchestrator.ts`)

The pipeline is a **directed graph** built with LangGraph. Each node is an async function that returns `Partial<QueryState>`.

### State Object (`QueryState`)

```typescript
{
  query: string,              // original user question
  subTasks: SubTask[],        // array of sub-tasks from Planner
  currentTaskIndex: number,   // which sub-task we're currently processing
  schemaContext: SchemaContext | null,  // full DB schema (loaded once, cached)
  selectedSchemaText: string, // filtered schema text for current sub-task
  currentSQL: string,         // SQL being executed for current sub-task
  sqlError: string | null,    // error from last DB execution attempt
  currentData: Record<string,unknown>[],  // rows returned by current SQL
  retryCount: number,         // how many times we've retried the current sub-task
  maxRetries: number,         // default: 3
  results: SubTaskResult[],   // collected results for all completed sub-tasks
  failedTasks: string[],      // descriptions of sub-tasks that failed after retries
  widgets: Widget[],          // final widgets to return in API response
  error: string | null,       // fatal error that stops the whole pipeline
}
```

### Graph Nodes and Flow

```
START
  │
  ▼
[plan]           → Planner decomposes query into N sub-tasks
  │
  ▼ (if error → END)
[selectSchema]   → Schema Selector picks relevant tables/columns for currentTaskIndex
  │
  ▼
[generateSQL]    → SQL Generator writes a PostgreSQL query
  │
  ▼
[executeSQL]     → dbExecutor validates + runs the SQL
  │
  ├── success → [collectResult]
  │
  └── error + retryCount < maxRetries → [refineSQL]
                                             │
                                             └── → [executeSQL] (loop)
                                         error + maxRetries exceeded → [collectResult] (empty data)

[collectResult]  → Saves result, increments currentTaskIndex
  │
  ├── more sub-tasks → [selectSchema]   (loop back)
  │
  └── all done → [visualize]
                     │
                     ▼
                   [END]
```

### Key Design: Refiner Error Handling

When the Refiner **itself** crashes (LLM call fails):

- Sets `retryCount = maxRetries` to force exit the retry loop
- Clears `currentSQL` and `sqlError`
- Sub-task is added to `failedTasks` (not fatal, pipeline continues)
- Other sub-tasks still run

When SQL fails and `retryCount >= maxRetries`:

- Collected with empty `data: []`
- Added to `failedTasks`
- Pipeline continues with next sub-task
- Visualizer appends a warning `ai_insight` widget

The `error` field (vs `sqlError`) is reserved for **fatal** errors that stop the whole pipeline (e.g. Planner LLM failure).

---

## Agents

### 1. Planner (`src/agents/planner.ts`)

**LLM model:** `llmModelPrimary`  
**Input:** user query string  
**Output:** `SubTask[]` (each with `id`, `description`, `type`, `dependsOn`)

**Task types:**

- `"data_query"` — the ONLY type used. SQL handles everything.
- `"calculation"` and `"comparison"` were removed from the schema. The Planner Zod schema uses `z.literal("data_query")` so the LLM cannot generate other types.

**Key prompt rules:**

- Max 5 sub-tasks
- Combine related things into one SQL with CTEs
- NEVER create summary/insight tasks (the Visualizer handles this)
- Each description must be self-contained with metric + time + filters

---

### 2. Schema Selector (`src/agents/schemaSelector.ts`)

**LLM model:** `llmModelFast` (cheaper, runs once per sub-task)  
**Input:** sub-task description + full enriched schema (from YAML)  
**Output:** selected tables with only relevant columns + reason

**IMPORTANT:** Schema is **cached** in memory after first load. Cache cleared via `POST /api/schema/refresh`. The cached schema is the enriched one (from YAML + `information_schema`).

**Output format:**

```typescript
{
  tableName: string,
  columns: string[],   // only the relevant column names
  reason: string       // why this table is needed
}[]
```

The `selectedSchemaText` injected into the SQL Generator prompt looks like:

```
TABLE: payment
  Columns: payment_id, customer_id, amount, payment_date
  Reason: Contains payment amounts for revenue calculation

TABLE: customer
  Columns: customer_id, first_name, last_name
  Reason: Needed to join customer names to payment data
```

---

### 3. SQL Generator (`src/agents/sqlGenerator.ts`)

**LLM model:** `llmModelPrimary`, `temperature: 0`  
**Input:** sub-task description + `selectedSchemaText`  
**Output:** `{ sql: string, explanation: string }`

**Rules injected from `src/prompts/sqlRules.md`:**

- SELECT only (no mutations)
- PostgreSQL syntax (DATE_TRUNC, EXTRACT, CTEs, ::casting)
- Always alias computed columns
- Use `DATE_TRUNC('month', col)` for monthly, `DATE_TRUNC('year', col)` for yearly
- `ROUND(value, 2)` for monetary amounts
- ORDER BY a logical column
- LIMIT N for "top N" queries
- COALESCE for nullable numerics
- CTEs over nested subqueries

---

### 4. Refiner (`src/agents/refiner.ts`)

**LLM model:** `llmModelPrimary`, `temperature: 0`  
**Input:** broken SQL + PostgreSQL error message + full schema  
**Output:** `{ sql: string, explanation: string }`

Triggered when: SQL execution fails and `retryCount < maxRetries`.  
Max retries: 3 (configurable in `config.maxRetries`).  
Uses `ChatPromptTemplate` (not prone to curly brace issue since it uses `{schema}` etc. as explicit template vars, not JSON data).

---

### 5. Visualizer (`src/agents/visualizer.ts`)

**LLM model:** `llmModelPrimary`, `temperature: 0.1`  
**Input:** user query + sub-task descriptions + **one sample row per sub-task** (NOT all rows)  
**Output:** widget design objects with field mappings

**CRITICAL ARCHITECTURE — Read carefully:**

The LLM does NOT receive all database rows. It receives only:

- The first row from each sub-task (to learn column names)
- The total row count

The LLM returns **field mapping designs** like:

```json
{
  "type": "bar_chart",
  "title": "Top Customers by Spending",
  "dataSourceIndex": 0,
  "categoryField": "customer_name",
  "valueFields": ["total_spent"],
  "xLabel": "Customer",
  "yLabel": "USD"
}
```

Then the **orchestrator's `visualizeNode`** attaches the real data:

```typescript
const { dataSourceIndex, ...widgetFields } = design;
return {
  ...widgetFields,
  data: successfulResults[dataSourceIndex].data, // full rows attached here
} as Widget;
```

**Why this way?** Prevents LLM context overflow for large result sets (thousands of rows).

**IMPORTANT — Curly brace gotcha:**  
The Visualizer uses `SystemMessage` / `HumanMessage` from `@langchain/core/messages`, NOT `ChatPromptTemplate`. Reason: the data context contains JSON like `{"month": "2007-01"}` — LangChain's template engine treats `{month}` as a template variable and crashes. Direct message objects bypass this.

The Zod schema for the Visualizer is **flat** (all fields at top level), not nested under `config`. If you use `config: z.any()`, the LLM will leave it empty because `z.any()` gives no guidance. Every field mapping (xField, yField, categoryField, etc.) must be a named Zod field with `.describe()`.

---

## Widget Types (`src/types/index.ts` + `src/prompts/widgetSchema.json`)

Every widget has:

- `type` — the widget component to render
- `title` — display title
- `data` — array of DB result rows (attached by orchestrator, not LLM)
- Field mappings — which DB columns to use for which axis

| Widget Type   | Field Mappings                                                            |
| ------------- | ------------------------------------------------------------------------- |
| `metric_card` | `valueField`, `aggregation` (sum/avg/count/...), `color`, `unit`, `trend` |
| `line_chart`  | `xField` (date col), `yFields[]`, `xLabel`, `yLabel`                      |
| `bar_chart`   | `categoryField`, `valueFields[]`, `xLabel`, `yLabel`                      |
| `donut_chart` | `labelField`, `valueField`                                                |
| `area_chart`  | `xField`, `yFields[]`, `xLabel`, `yLabel`                                 |
| `gauge`       | `valueField`, `aggregation`, `min`, `max`, `unit`, `thresholds[]`         |
| `data_table`  | `columns[]` (each has `key`=DB col name, `label`=header, `sortable?`)     |
| `ai_insight`  | `text` (markdown), `severity` (info/success/warning/danger) — no data     |

**Frontend rendering pattern:**

```javascript
// Example for bar_chart
const categories = widget.data.map((row) => row[widget.categoryField]);
const values = widget.data.map((row) => row[widget.valueFields[0]]);
```

---

## Database Schema Loading (`src/config/database.ts`)

Schema is loaded in two steps and merged:

**Step 1: Auto-discovery**  
Queries `information_schema.columns` to get all tables, column names, and data types.

**Step 2: YAML enrichment**  
Reads `src/prompts/schema_descriptions.yaml`. This file contains developer-written descriptions:

```yaml
tables:
  - name: payment
    description: "All payment transactions..."
    business_context: "THE most important table for revenue queries..."
    columns:
      - name: amount
        description: "Payment amount in USD. ALL values are POSITIVE (revenue)."
        role: metric
        examples: ["0.99", "2.99", "4.99"]
    relationships:
      - from: payment.customer_id
        to: customer.customer_id
        type: many-to-one
        description: "Each payment belongs to one customer"
    sample_queries:
      - description: "Total revenue"
        sql: "SELECT SUM(amount) FROM payment"
```

The merged schema string (`schemaContext.raw`) is injected into the Schema Selector prompt. If the YAML file is missing, it falls back to raw column names (with a console warning).

**To scaffold a new YAML for a new database:**

```bash
npx tsx scripts/generate-schema.ts
```

This auto-discovers all tables and generates a YAML with empty description fields.

---

## SQL Safety (`src/tools/dbExecutor.ts`)

All SQL goes through `executeSafeSQL()`:

1. **Keyword blocklist:** DROP, DELETE, TRUNCATE, ALTER, INSERT, UPDATE, CREATE, GRANT, REVOKE → rejected immediately
2. **Must start with SELECT or WITH** (CTEs allowed)
3. **Statement timeout:** `SET statement_timeout = '30s'` run separately before the query (combined calls cause `pg` to return an array of Results — bug avoided by separating them)

---

## Key Files to Edit for Common Changes

| Goal                              | File(s) to edit                                                                |
| --------------------------------- | ------------------------------------------------------------------------------ |
| Change how queries are decomposed | `src/agents/planner.ts` (prompt)                                               |
| Change SQL generation rules       | `src/prompts/sqlRules.md`                                                      |
| Add business context to DB tables | `src/prompts/schema_descriptions.yaml`                                         |
| Add a new widget type             | `src/types/index.ts` + `src/prompts/widgetSchema.json` + Visualizer Zod schema |
| Change which LLM model is used    | `.env` (`LLM_MODEL_PRIMARY`, `LLM_MODEL_FAST`)                                 |
| Change retry attempts             | `src/config/index.ts` (`maxRetries`) or per-query in `orchestrator.ts`         |
| Change SQL timeout                | `src/tools/dbExecutor.ts` (the SET statement)                                  |
| Add a new API endpoint            | `src/app.ts`                                                                   |

---

## Known Gotchas & Design Decisions

1. **LangGraph recursion limit**: Set to `100` in `processQuery()`. Each sub-task uses ~4-5 graph iterations (selectSchema → generateSQL → executeSQL → refineSQL loop → collectResult). Default was 25 which broke for 5+ sub-tasks.

2. **`ChatPromptTemplate` vs direct messages**: The Visualizer uses `SystemMessage`/`HumanMessage` directly (not `ChatPromptTemplate`) because LangChain template parsing treats `{column_name}` in JSON data as template variables, causing crashes.

3. **`pg` multi-statement bug**: When you do `pg.query("SET timeout; SELECT ...")`, pg returns an array of Result objects, not a single Result. Always use two separate `pg.query()` calls for SET + SELECT.

4. **Zod schema for structured output**: `z.any()` for nested objects gives the LLM zero guidance and it returns empty objects. Always use explicit named fields with `.describe()` for every field you want the LLM to fill.

5. **Schema cache**: Loaded once at first query and cached in memory. If DB schema changes, call `POST /api/schema/refresh` to reload it.

6. **Widget `data` field**: Set by the orchestrator's `visualizeNode`, NOT by the LLM. The LLM only sets `dataSourceIndex` (which sub-task's rows to attach). If `dataSourceIndex` is undefined or out of range, the widget gets no data.

7. **Failed sub-tasks**: Tasks that fail after max retries are added to `failedTasks[]`. The Visualizer appends a warning `ai_insight` widget listing them. This is non-fatal — other sub-tasks still run.

8. **`ai_insight` has no `data` field**: Unlike all other widget types. The `dataSourceIndex` check gates on `type !== "ai_insight"` before attaching data.
