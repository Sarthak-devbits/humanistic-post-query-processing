// ─── Financial Calculation Utilities ─────────────────────────────────────────

/**
 * Compound Annual Growth Rate
 * CAGR = (endValue / startValue)^(1/years) - 1
 */
export function calculateCAGR(
  startValue: number,
  endValue: number,
  years: number,
): number {
  if (startValue <= 0 || years <= 0) return 0;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

/**
 * Cash Runway in months
 * How many months the business can sustain with current balance
 */
export function calculateRunway(
  currentBalance: number,
  avgMonthlyExpense: number,
): number {
  if (avgMonthlyExpense <= 0) return Infinity;
  return Math.round((currentBalance / avgMonthlyExpense) * 10) / 10;
}

/**
 * Determine the trend direction of a data series
 */
export function calculateTrend(dataPoints: number[]): "up" | "down" | "flat" {
  if (dataPoints.length < 2) return "flat";

  const first = dataPoints[0];
  const last = dataPoints[dataPoints.length - 1];
  const threshold = Math.abs(first) * 0.02; // 2% threshold

  if (last - first > threshold) return "up";
  if (first - last > threshold) return "down";
  return "flat";
}

/**
 * Calculate percentage change between two values
 */
export function percentageChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return newValue > 0 ? 100 : -100;
  return (
    Math.round(((newValue - oldValue) / Math.abs(oldValue)) * 100 * 10) / 10
  );
}

/**
 * Calculate simple moving average
 */
export function movingAverage(dataPoints: number[], window: number): number[] {
  if (window <= 0 || dataPoints.length < window) return [];
  const result: number[] = [];
  for (let i = window - 1; i < dataPoints.length; i++) {
    const slice = dataPoints.slice(i - window + 1, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / window;
    result.push(Math.round(avg * 100) / 100);
  }
  return result;
}

/**
 * Format a number as currency string
 */
export function formatCurrency(
  value: number,
  currency: string = "USD",
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}
