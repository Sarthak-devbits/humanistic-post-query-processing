# 🧠 Humanistic — Text-to-SQL & Visualization Engine

> Transform natural language financial questions into SQL queries and rich dashboard widgets, powered by LangChain, LangGraph, and PostgreSQL.

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript&logoColor=white)
![LangChain](https://img.shields.io/badge/LangChain-0.3+-1C3C3C?logo=langchain&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-4169E1?logo=postgresql&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.21+-000000?logo=express&logoColor=white)

---

## 📖 Overview

Humanistic is a backend API that lets users ask complex financial questions in plain English. The system:

1. **Decomposes** the question into atomic sub-tasks
2. **Generates** PostgreSQL queries for each sub-task
3. **Self-heals** by auto-fixing SQL errors (up to 3 retries)
4. **Visualizes** results as structured widget JSON for any frontend

### Example

```
User: "What is the profit I had last 3 years and do I have enough
       money to sustain next 2 years for my crops?"
```

The system splits this into sub-tasks, queries your database, and returns widgets like metric cards, line charts, sustainability gauges, and AI insights — all as structured JSON.

---

## 🏗️ Architecture

### High-Level Flow

```mermaid
graph LR
    A["🧑 User"] -->|"POST /api/query"| B["🌐 Express API"]
    B --> C["🤖 LangGraph Orchestrator"]
    C --> D["📊 Widget JSON"]
    D --> A

    style A fill:#4F46E5,color:#fff
    style B fill:#059669,color:#fff
    style C fill:#D97706,color:#fff
    style D fill:#7C3AED,color:#fff
```

### Orchestrator State Machine (The "Brain")

```mermaid
graph TD
    START(["🟢 User Query"]) --> PLAN["🧠 Planner Agent<br/>Decompose into sub-tasks"]
    PLAN --> LOOP{"For each<br/>sub-task"}

    LOOP --> SCHEMA["🔍 Schema Selector<br/>Pick relevant tables"]
    SCHEMA --> SQLGEN["✍️ SQL Generator<br/>Write PostgreSQL query"]
    SQLGEN --> EXEC{"⚡ Execute SQL"}

    EXEC -->|"✅ Success"| COLLECT["📦 Collect Result"]
    EXEC -->|"❌ Error"| RETRY{"Retries < 3?"}

    RETRY -->|"Yes"| REFINE["🔧 Refiner Agent<br/>Fix the SQL"]
    REFINE --> EXEC
    RETRY -->|"No"| COLLECT

    COLLECT --> MORE{"More<br/>sub-tasks?"}
    MORE -->|"Yes"| LOOP
    MORE -->|"No"| VIZ["🎨 Visualizer Agent<br/>Map data → widgets"]

    VIZ --> DONE(["🏁 Widget JSON Response"])

    style START fill:#22C55E,color:#fff
    style PLAN fill:#3B82F6,color:#fff
    style SCHEMA fill:#6366F1,color:#fff
    style SQLGEN fill:#8B5CF6,color:#fff
    style EXEC fill:#F59E0B,color:#000
    style REFINE fill:#EF4444,color:#fff
    style COLLECT fill:#14B8A6,color:#fff
    style VIZ fill:#EC4899,color:#fff
    style DONE fill:#22C55E,color:#fff
```

### Agent Responsibilities

```mermaid
graph TB
    subgraph Agents["🤖 AI Agents"]
        P["🧠 Planner<br/>Query decomposition"]
        SS["🔍 Schema Selector<br/>Table/column RAG"]
        SG["✍️ SQL Generator<br/>Query writing"]
        R["🔧 Refiner<br/>Error correction"]
        V["🎨 Visualizer<br/>Widget mapping"]
    end

    subgraph Tools["🔧 Tools"]
        DB["⚡ DB Executor<br/>Safe SQL runner"]
        FIN["📐 Finance Utils<br/>CAGR, Runway, Trends"]
    end

    subgraph Prompts["📝 Prompts & Schemas"]
        SR["SQL Rules<br/>sqlRules.md"]
        WS["Widget Contract<br/>widgetSchema.json"]
    end

    P --> SS --> SG --> DB
    SG -.->|uses| SR
    R --> DB
    V -.->|uses| WS
    V -.->|uses| FIN

    style Agents fill:#EFF6FF,stroke:#3B82F6
    style Tools fill:#FEF3C7,stroke:#F59E0B
    style Prompts fill:#F3E8FF,stroke:#8B5CF6
```

---

## 📁 Project Structure

```
humanistic/
├── .env.example              # Environment variables template
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── app.ts                 # Express server & API routes
    ├── orchestrator.ts        # LangGraph state machine
    ├── config/
    │   ├── index.ts           # Environment config loader
    │   └── database.ts        # PostgreSQL pool & schema discovery
    ├── types/
    │   └── index.ts           # All TypeScript interfaces
    ├── agents/
    │   ├── planner.ts         # Decomposes queries → sub-tasks
    │   ├── schemaSelector.ts  # RAG: picks relevant tables
    │   ├── sqlGenerator.ts    # Writes PostgreSQL queries
    │   ├── refiner.ts         # Self-healing SQL debugger
    │   └── visualizer.ts      # Data → widget JSON mapper
    ├── tools/
    │   ├── dbExecutor.ts      # Safe SQL execution layer
    │   └── financeUtils.ts    # CAGR, runway, trend helpers
    └── prompts/
        ├── sqlRules.md        # SQL generation constraints
        └── widgetSchema.json  # Widget type contract (8 types)
```

---

## 📊 Widget Types

The API returns an array of widgets. Each widget has a `type` and widget-specific data:

| #   | Widget          | Type Key      | Best For                                   |
| --- | --------------- | ------------- | ------------------------------------------ |
| 1   | **Metric Card** | `metric_card` | Single KPI (Total Profit: $125K ↑12%)      |
| 2   | **Line Chart**  | `line_chart`  | Time-series trends (profit over 3 years)   |
| 3   | **Gauge**       | `gauge`       | Sustainability runway (months remaining)   |
| 4   | **Bar Chart**   | `bar_chart`   | Category comparisons (revenue vs expenses) |
| 5   | **Donut Chart** | `donut_chart` | Part-of-whole (expense breakdown)          |
| 6   | **Area Chart**  | `area_chart`  | Projected vs actual cash flow              |
| 7   | **Data Table**  | `data_table`  | Detailed searchable row data               |
| 8   | **AI Insight**  | `ai_insight`  | Natural language summary + severity        |

### Widget Response Example

```mermaid
graph LR
    subgraph Response["API Response"]
        direction TB
        W1["📈 metric_card<br/>Total Profit: $125K"]
        W2["📉 line_chart<br/>3-Year Trend"]
        W3["🎯 gauge<br/>Runway: 18 months"]
        W4["💡 ai_insight<br/>'Your profit grew 12%...'"]
    end

    style Response fill:#F0FDF4,stroke:#22C55E
    style W1 fill:#DCFCE7,stroke:#16A34A
    style W2 fill:#DBEAFE,stroke:#2563EB
    style W3 fill:#FEF9C3,stroke:#CA8A04
    style W4 fill:#F3E8FF,stroke:#9333EA
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20+
- **PostgreSQL** 15+ with your financial data loaded
- **OpenAI API Key** (for GPT-4o / GPT-4o-mini)

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd humanistic

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

### Environment Variables

Edit `.env` with your values:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/financial_db
OPENAI_API_KEY=sk-your-key-here
PORT=3000

# Optional: Override LLM models
LLM_MODEL_PRIMARY=gpt-4o
LLM_MODEL_FAST=gpt-4o-mini
```

### Run

```bash
# Development (hot-reload)
npm run dev

# Production build
npm run build
npm start
```

---

## 📡 API Reference

### `GET /api/health`

Health check endpoint.

```bash
curl http://localhost:3000/api/health
```

```json
{
  "status": "ok",
  "timestamp": "2026-03-09T08:00:00.000Z",
  "database": "connected",
  "version": "1.0.0"
}
```

### `GET /api/schema`

Returns the discovered database schema (tables and columns).

```bash
curl http://localhost:3000/api/schema
```

### `POST /api/schema/refresh`

Clears the cached schema and reloads from the database.

### `POST /api/query`

Main endpoint — processes a natural language financial question.

```bash
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "What is the profit I had last 3 years and do I have enough money to sustain next 2 years for my crops?"}'
```

**Response:**

```json
{
  "success": true,
  "query": "What is the profit I had last 3 years...",
  "widgets": [
    {
      "type": "metric_card",
      "title": "Total Profit (3 Years)",
      "value": "$125,400",
      "trend": "up",
      "trendValue": "+12.3%",
      "color": "green"
    },
    {
      "type": "line_chart",
      "title": "Yearly Profit Trend",
      "xLabel": "Year",
      "yLabel": "Profit ($)",
      "series": [
        {
          "name": "Profit",
          "data": [
            { "x": "2023", "y": 35000 },
            { "x": "2024", "y": 42000 },
            { "x": "2025", "y": 48400 }
          ]
        }
      ]
    },
    {
      "type": "gauge",
      "title": "Financial Sustainability",
      "value": 18,
      "min": 0,
      "max": 36,
      "unit": "months",
      "thresholds": [
        { "value": 12, "color": "#EF4444", "label": "At Risk" },
        { "value": 24, "color": "#F59E0B", "label": "Caution" },
        { "value": 36, "color": "#22C55E", "label": "Safe" }
      ]
    },
    {
      "type": "ai_insight",
      "title": "Financial Summary",
      "text": "Your profit has grown at a 12.3% CAGR over the last 3 years. However, your current cash runway is 18 months, which is below the 24-month target for crop sustainability. Consider reducing expenses or securing additional funding.",
      "severity": "warning"
    }
  ],
  "executionTimeMs": 4532
}
```

---

## 🔒 Safety Features

| Feature                     | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| **SQL Keyword Blocking**    | `DROP`, `DELETE`, `TRUNCATE`, `ALTER`, `INSERT`, `UPDATE`, `CREATE` are blocked |
| **SELECT-Only Enforcement** | Queries must start with `SELECT` or `WITH`                                      |
| **Query Timeout**           | 30-second timeout per SQL execution                                             |
| **Self-Healing Loop**       | Up to 3 automatic retries with AI-powered SQL correction                        |
| **Input Validation**        | Empty/invalid queries are rejected with 400 errors                              |

---

## 🛠️ Tech Stack

| Layer             | Technology                           |
| ----------------- | ------------------------------------ |
| Runtime           | Node.js 22+                          |
| Language          | TypeScript 5.7 (strict mode)         |
| Framework         | Express 4.21                         |
| Database          | PostgreSQL 15+ via `pg`              |
| AI Orchestration  | LangGraph (state machine)            |
| AI Framework      | LangChain + `@langchain/openai`      |
| Structured Output | Zod schemas                          |
| LLM Models        | GPT-4o (primary), GPT-4o-mini (fast) |

---

## 📄 License

MIT
# humanistic-post-query-processing
