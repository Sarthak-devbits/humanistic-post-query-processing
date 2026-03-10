import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl: process.env.DATABASE_URL || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  llmModelPrimary: process.env.LLM_MODEL_PRIMARY || "gpt-4o",
  llmModelFast: process.env.LLM_MODEL_FAST || "gpt-4o-mini",
  maxRetries: 3,
  sqlTimeoutMs: 30_000,
} as const;

export function validateConfig(): void {
  const missing: string[] = [];

  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");

  if (missing.length > 0) {
    console.warn(
      `⚠️  Missing environment variables: ${missing.join(", ")}. Some features will not work.`,
    );
  }
}
