import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { AppleMusicSong } from "./types.js";

export const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "apple",
  "are",
  "based",
  "best",
  "create",
  "for",
  "get",
  "great",
  "i",
  "in",
  "into",
  "it",
  "like",
  "me",
  "mix",
  "music",
  "my",
  "of",
  "on",
  "playlist",
  "please",
  "playlists",
  "recent",
  "some",
  "songs",
  "start",
  "starter",
  "that",
  "the",
  "these",
  "to",
  "track",
  "tracks",
  "tunes",
  "want",
  "with",
]);

export const DISCOVERY_PATTERNS = [/\bget into\b/i, /\bwhere should i start\b/i, /\bdive into\b/i, /\bnew to\b/i, /\bbeginner\b/i];
export const STARTER_PATTERNS = [/\bstarter\b/i, /\bessentials\b/i, /\bintro\b/i, /\bintroduction\b/i, /\bentry point\b/i];

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s,/'&+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[\s,/'&+-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function derivePlaylistName(description: string): string {
  const base = description
    .replace(/^i\s+want\s+/i, "")
    .replace(/^create\s+/i, "")
    .replace(/^make\s+/i, "")
    .replace(/^a\s+playlist\s+/i, "")
    .replace(/^an\s+apple\s+music\s+playlist\s+/i, "")
    .trim();

  const words = base.split(/\s+/).filter(Boolean).slice(0, 6);
  const title = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return title || "Pi Playlist";
}

export function compactText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function songLabel(song: AppleMusicSong): string {
  const name = song.attributes?.name ?? "Unknown title";
  const artist = song.attributes?.artistName ?? "Unknown artist";
  return `${name} — ${artist}`;
}

export function formatBulletList(values: string[], prefix = "- "): string {
  return values.map((value) => `${prefix}${value}`).join("\n");
}

export function slugify(value: string): string {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "playlist";
}

export function splitPromptSegments(description: string): string[] {
  return unique(
    description
      .split(/[,;]+/)
      .map((part) => part.trim())
      .filter((part) => normalizeText(part).length >= 3),
  );
}

export function containsNormalizedPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalizeText(text)} `;
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  return normalizedText.includes(` ${normalizedPhrase} `);
}

export function hasPattern(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function assistantTextContent(text: string) {
  return [{ type: "text", text }] as Array<{ type: "text"; text: string }>;
}

export function appendAssistantTextMessage(pi: ExtensionAPI, _ctx: any, text: string): void {
  pi.sendMessage({
    customType: "apple-music-result",
    content: text,
    display: true,
    details: { timestamp: Date.now() },
  });
}
