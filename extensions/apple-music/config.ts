import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AppleMusicConfig } from "./types.js";
import { normalizeText, slugify, unique, compactText } from "./utils.js";
import type { CandidateSong, PlaylistPlan } from "./types.js";

export async function readJsonIfExists(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

export async function loadConfig(cwd: string): Promise<AppleMusicConfig> {
  const projectPath = join(cwd, ".pi", "apple-music.json");
  const userPath = join(homedir(), ".pi", "agent", "apple-music.json");

  const [userConfig, projectConfig] = await Promise.all([readJsonIfExists(userPath), readJsonIfExists(projectPath)]);

  return {
    developerToken:
      process.env.APPLE_MUSIC_DEVELOPER_TOKEN ??
      (projectConfig?.developerToken as string | undefined) ??
      (userConfig?.developerToken as string | undefined),
    musicUserToken:
      process.env.APPLE_MUSIC_USER_TOKEN ??
      (projectConfig?.musicUserToken as string | undefined) ??
      (userConfig?.musicUserToken as string | undefined),
    storefront:
      process.env.APPLE_MUSIC_STOREFRONT ??
      (projectConfig?.storefront as string | undefined) ??
      (userConfig?.storefront as string | undefined) ??
      "us",
    plannerModel:
      process.env.APPLE_MUSIC_PLANNER_MODEL ??
      (projectConfig?.plannerModel as string | undefined) ??
      (userConfig?.plannerModel as string | undefined),
  };
}

export function ensureApiConfig(config: AppleMusicConfig): asserts config is Required<AppleMusicConfig> {
  if (!config.developerToken) {
    throw new Error("Missing Apple Music developer token. Set APPLE_MUSIC_DEVELOPER_TOKEN or .pi/apple-music.json.");
  }
  if (!config.musicUserToken) {
    throw new Error("Missing Apple Music user token. Set APPLE_MUSIC_USER_TOKEN or .pi/apple-music.json.");
  }
  if (!config.storefront) {
    throw new Error("Missing Apple Music storefront. Set APPLE_MUSIC_STOREFRONT or .pi/apple-music.json.");
  }
}

export function buildStoredPlaylistDescription(originalPrompt: string, plan: PlaylistPlan, selectionSeed?: string): string {
  const refinements = unique(
    [
      plan.facets.length > 0 ? `facets=${plan.facets.slice(0, 5).join(", ")}` : "",
      plan.moods.length > 0 ? `moods=${plan.moods.slice(0, 4).join(", ")}` : "",
      ...plan.notes.filter((note) => note !== "LLM-assisted plan").slice(0, 2),
      plan.optionalDirections.length > 0 ? `directions=${plan.optionalDirections.slice(0, 2).join(" | ")}` : "",
      plan.discoveryIntent || plan.starterIntent ? "mode=discovery/starter" : "",
    ].filter(Boolean),
  ).slice(0, 5);

  const lines = [
    `Prompt: ${compactText(originalPrompt, 220)}`,
    `Refinements: ${refinements.length > 0 ? refinements.join("; ") : "none"}`,
    selectionSeed ? `Selection seed: ${selectionSeed}` : "",
  ].filter(Boolean);

  return compactText(lines.join("\n"), 500);
}

export function proposalDirectory(cwd: string): string {
  return join(cwd, ".pi", "apple-music-proposals");
}

export async function writeProposalFile(
  cwd: string,
  data: Record<string, unknown>,
  proposalId?: string,
): Promise<{ proposalId: string; proposalPath: string }> {
  const dir = proposalDirectory(cwd);
  await mkdir(dir, { recursive: true });
  const resolvedProposalId = proposalId ?? `${Date.now()}-${slugify(String(data.playlistName ?? data.description ?? "proposal"))}`;
  const proposalPath = join(dir, `${resolvedProposalId}.json`);
  await writeFile(proposalPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { proposalId: resolvedProposalId, proposalPath };
}

export async function updateProposalFile(proposalPath: string, patch: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(proposalPath, "utf8")) as Record<string, unknown>;
  await writeFile(proposalPath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
}

export async function resolveProposalPath(cwd: string, proposalRef?: string): Promise<string | undefined> {
  const dir = proposalDirectory(cwd);
  try {
    const entries = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    if (entries.length === 0) return undefined;
    if (!proposalRef || proposalRef === "last") {
      return join(dir, entries[entries.length - 1]);
    }
    if (proposalRef.endsWith(".json")) return join(dir, proposalRef);
    const exact = entries.find((name) => name === `${proposalRef}.json` || name.includes(proposalRef));
    return exact ? join(dir, exact) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadProposal(cwd: string, proposalRef?: string): Promise<{ path: string; data: any } | undefined> {
  const path = await resolveProposalPath(cwd, proposalRef);
  if (!path) return undefined;
  return { path, data: JSON.parse(await readFile(path, "utf8")) };
}

export function summarizeSkippedTracks(proposal: any, maxItems = 20): string {
  const skippedTracks = Array.isArray(proposal.skippedTracks) ? proposal.skippedTracks : [];
  if (skippedTracks.length === 0) return "No skipped tracks recorded.";

  const byReason = new Map<string, any[]>();
  for (const track of skippedTracks) {
    const reason = String(track.skipReason ?? "unknown");
    const list = byReason.get(reason) ?? [];
    list.push(track);
    byReason.set(reason, list);
  }

  const sections: string[] = [];
  let shown = 0;
  for (const [reason, tracks] of byReason.entries()) {
    if (shown >= maxItems) break;
    const remaining = maxItems - shown;
    const sample = tracks.slice(0, remaining).map((track: any) => `- ${track.name ?? "Unknown title"} — ${track.artistName ?? "Unknown artist"}${track.sourceReleaseName ? ` [${track.sourceReleaseName}]` : ""}`);
    sections.push(`${reason} (${tracks.length})\n${sample.join("\n")}`);
    shown += sample.length;
  }

  return sections.join("\n\n");
}

export function candidateToSerializable(candidate: CandidateSong) {
  return {
    id: candidate.song.id,
    name: candidate.song.attributes?.name,
    artistName: candidate.song.attributes?.artistName,
    albumName: candidate.song.attributes?.albumName,
    sourceReleaseName: candidate.sourceReleaseName,
    sourceReleaseType: candidate.sourceReleaseType,
    genreNames: candidate.song.attributes?.genreNames,
    url: candidate.song.attributes?.url,
    score: candidate.score,
    reasons: [...candidate.reasons].slice(0, 8),
  };
}
