/** Validate and normalise a URL before passing to yt-dlp */

import { DownloadError, DownloadErrorCode } from "../types";

const URL_REGEX = /^https?:\/\//i;
const INVALID_CHARS = /[\0\n\r]/g;

/** Domain list for platform detection */
const PLATFORM_DOMAINS: Record<string, string[]> = {
  youtube: [
    "youtube.com",
    "m.youtube.com",
    "youtu.be",
    "music.youtube.com",
    "www.youtube.com",
  ],
  twitter: ["twitter.com", "x.com", "t.co", "www.twitter.com", "www.x.com"],
  tiktok: ["tiktok.com", "vm.tiktok.com", "www.tiktok.com"],
  instagram: ["instagram.com", "instagr.am", "www.instagram.com"],
  snapchat: ["snapchat.com", "snapchat.app.link", "www.snapchat.com"],
};

/**
 * Check if a hostname matches a platform domain using exact domain matching.
 */
function matchesDomain(hostname: string, domains: string[]): boolean {
  for (const domain of domains) {
    if (hostname === domain) return true;
    if (hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * Validate a URL string.
 * Returns the cleaned URL or null if invalid.
 */
export function validateUrl(input: string): string | null {
  const cleaned = input.trim().replace(INVALID_CHARS, "");
  if (!URL_REGEX.test(cleaned)) return null;
  try {
    new URL(cleaned);
    return cleaned;
  } catch {
    return null;
  }
}

/**
 * Validate a URL and throw a classified error if invalid.
 */
export function validateUrlOrThrow(input: string): string {
  const cleaned = input.trim().replace(INVALID_CHARS, "");
  if (!URL_REGEX.test(cleaned)) {
    throw new DownloadError(
      DownloadErrorCode.INVALID_URL,
      "URL must start with http:// or https://",
    );
  }
  try {
    new URL(cleaned);
    return cleaned;
  } catch {
    throw new DownloadError(
      DownloadErrorCode.INVALID_URL,
      "Malformed URL — could not parse",
    );
  }
}

/**
 * Detect platform from URL using exact domain matching.
 */
export function detectPlatform(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase();

  for (const [platform, domains] of Object.entries(PLATFORM_DOMAINS)) {
    if (matchesDomain(hostname, domains)) {
      return platform;
    }
  }

  return "other";
}
