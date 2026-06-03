import { renderProgressBar } from "./utils/format";
import type { ProgressEvent } from "./types";

/**
 * Build the progress bar text for status updates.
 */
export function buildProgressText(pct: string, speed: string, eta: string): string {
  const num = parseFloat(pct) || 0;
  const bar = renderProgressBar(num);
  return `⏬ Downloading...\n${bar} ${pct}%\n⚡ ${speed}  ⏱ ${eta}`;
}

/**
 * Build a compact progress text for edit-message updates.
 */
export function buildCompactProgress(event: ProgressEvent): string {
  const bar = renderProgressBar(event.percent);
  return `⏬ Downloading...\n${bar} ${event.percent.toFixed(1)}%\n⚡ ${event.speed}  ⏱ ${event.eta}`;
}
