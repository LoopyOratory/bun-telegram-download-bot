import { renderProgressBar } from "./utils/format";
import type { ProgressEvent } from "./types";

/** Braille spinner frames for animation */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Download indicator frames */
const DOWNLOAD_ICONS = ["⏬", "⏳", "⏬"];

/** Global animation frame counter */
let frameCounter = 0;

/**
 * Get the next animation frame and increment the counter.
 */
function nextFrame(total: number): number {
  frameCounter = (frameCounter + 1) % total;
  return frameCounter;
}

/**
 * Build an animated progress bar with a "pulse" block at the fill point.
 * The filled portion uses solid blocks, with one animated shimmer block at the edge.
 */
function renderAnimatedBar(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width);
  const spinner = SPINNER[nextFrame(SPINNER.length)];
  const pulse = percent < 100 ? SPINNER[(frameCounter + 3) % SPINNER.length] : "▰";

  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i < filled - 1) {
      bar += "▰";
    } else if (i === filled - 1 && filled > 0 && percent < 100) {
      bar += pulse; // shimmer at the fill edge
    } else if (i === filled && filled < width) {
      bar += "▱";
    } else {
      bar += filled >= width ? "▰" : "▱";
    }
  }

  return `${spinner} ${bar}`;
}

/**
 * Build a compact animated progress text for edit-message updates.
 */
export function buildCompactProgress(event: ProgressEvent): string {
  const downloadIcon = DOWNLOAD_ICONS[nextFrame(DOWNLOAD_ICONS.length)];
  const bar = renderAnimatedBar(event.percent);
  const pct = event.percent.toFixed(1);

  return [
    `${downloadIcon} Downloading ${pct}%`,
    bar,
    `⚡ ${event.speed}  ⏱ ${event.eta}`,
  ].join("\n");
}

/**
 * Build the progress bar text for status updates.
 */
export function buildProgressText(pct: string, speed: string, eta: string): string {
  const num = parseFloat(pct) || 0;
  const bar = renderAnimatedBar(num);
  const spinner = SPINNER[nextFrame(SPINNER.length)];
  return `${spinner} Downloading...\n${bar} ${pct}%\n⚡ ${speed}  ⏱ ${eta}`;
}
