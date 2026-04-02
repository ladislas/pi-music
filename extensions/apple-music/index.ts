import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { complete, StringEnum, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { GENRE_SEED_MAP, type SeedGenreEntry } from "./genre-seeds.js";

type AppleMusicConfig = {
  developerToken?: string;
  musicUserToken?: string;
  storefront?: string;
  plannerModel?: string;
};

type AppleMusicSong = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    genreNames?: string[];
    url?: string;
  };
};

type AppleMusicArtist = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    genreNames?: string[];
    editorialNotes?: { standard?: string; short?: string };
  };
};

type AppleMusicAlbum = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    genreNames?: string[];
    editorialNotes?: { standard?: string; short?: string };
  };
};

type AppleMusicPlaylist = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    curatorName?: string;
    description?: { standard?: string; short?: string };
    editorialNotes?: { standard?: string; short?: string };
    playlistType?: string;
  };
};

type SearchResponse = {
  results?: {
    songs?: { data?: AppleMusicSong[] };
    artists?: { data?: AppleMusicArtist[] };
    albums?: { data?: AppleMusicAlbum[] };
    playlists?: { data?: AppleMusicPlaylist[] };
  };
};

type TracksResponse = {
  data?: AppleMusicSong[];
};

type CreatePlaylistResponse = {
  data?: Array<{
    id: string;
    type: string;
    attributes?: {
      name?: string;
      description?: { standard?: string };
    };
  }>;
};

type LibraryPlaylistFolder = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    description?: { standard?: string; short?: string };
  };
};

type LibraryPlaylistFoldersResponse = {
  data?: LibraryPlaylistFolder[];
  next?: string;
};

type PlaylistPlannerSuggestion = {
  inferredGenres?: string[];
  facets?: string[];
  queries?: string[];
  seedArtists?: string[];
  relatedArtists?: string[];
  moods?: string[];
  avoidTerms?: string[];
  notes?: string[];
  optionalDirections?: string[];
  clarifyingQuestions?: string[];
  familiarArtists?: string[];
  discoveryIntent?: boolean;
  starterIntent?: boolean;
  broadRequest?: boolean;
};

type PlaylistPlan = {
  originalDescription: string;
  normalizedDescription: string;
  inferredGenres: string[];
  matchedSeedEntries: SeedGenreEntry[];
  facets: string[];
  queries: string[];
  seedArtists: string[];
  relatedArtists: string[];
  avoidTerms: string[];
  optionalDirections: string[];
  clarifyingQuestions: string[];
  familiarArtists: string[];
  discographyIntent: boolean;
  strictArtistOnly: boolean;
  targetArtist?: string;
  discoveryIntent: boolean;
  starterIntent: boolean;
  broadRequest: boolean;
  moods: string[];
  notes: string[];
};

type CandidateSong = {
  song: AppleMusicSong;
  directSongHits: number;
  artistTopSongHits: number;
  albumTrackHits: number;
  playlistTrackHits: number;
  editorialAlbumHits: number;
  editorialPlaylistHits: number;
  seedArtistHits: number;
  relatedArtistHits: number;
  queryMatches: Set<string>;
  genresMatched: Set<string>;
  facetMatches: Set<string>;
  reasons: Set<string>;
  sourceReleaseName?: string;
  sourceReleaseType?: "album" | "ep" | "single" | "other";
  score: number;
};

type PlannerRuntime = {
  model?: any;
  modelRegistry?: any;
  plannerModel?: string;
  cwd?: string;
};

const APPLE_MUSIC_FOLDER_NAME = "piMusic";
const APPLE_MUSIC_MOVE_INITIAL_DELAY_MS = 10_000;
const APPLE_MUSIC_MOVE_RETRY_DELAY_MS = 2_500;
const APPLE_MUSIC_MOVE_ATTEMPTS = 4;
const PREVIEW_PROPOSAL_CACHE = new Map<string, Awaited<ReturnType<typeof buildCuratedPlaylistPreview>>>();
const PLAYLIST_FOLDER_ID_CACHE = new Map<string, string>();

const TRANSPORT_ACTIONS = [
  "play",
  "pause",
  "playpause",
  "next",
  "previous",
  "stop",
  "shuffle_on",
  "shuffle_off",
  "shuffle_toggle",
  "repeat_off",
  "repeat_one",
  "repeat_all",
  "set_volume",
  "play_playlist",
  "status",
] as const;

const STOP_WORDS = new Set([
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

const DISCOVERY_PATTERNS = [/\bget into\b/i, /\bwhere should i start\b/i, /\bdive into\b/i, /\bnew to\b/i, /\bbeginner\b/i];
const STARTER_PATTERNS = [/\bstarter\b/i, /\bessentials\b/i, /\bintro\b/i, /\bintroduction\b/i, /\bentry point\b/i];

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

async function loadConfig(cwd: string): Promise<AppleMusicConfig> {
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

function ensureApiConfig(config: AppleMusicConfig): asserts config is Required<AppleMusicConfig> {
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

async function appleMusicRequest<T>(path: string, config: Required<AppleMusicConfig>, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.music.apple.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.developerToken}`,
      "Music-User-Token": config.musicUserToken,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Apple Music API error ${response.status}: ${body}`);
  }

  if (!body.trim()) {
    return undefined as T;
  }

  return JSON.parse(body) as T;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s,/'&+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[\s,/'&+-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function derivePlaylistName(description: string): string {
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

function compactText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function buildStoredPlaylistDescription(originalPrompt: string, plan: PlaylistPlan, selectionSeed?: string): string {
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

function songLabel(song: AppleMusicSong): string {
  const name = song.attributes?.name ?? "Unknown title";
  const artist = song.attributes?.artistName ?? "Unknown artist";
  return `${name} — ${artist}`;
}

function formatBulletList(values: string[], prefix = "- "): string {
  return values.map((value) => `${prefix}${value}`).join("\n");
}

function slugify(value: string): string {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "playlist";
}

function proposalDirectory(cwd: string): string {
  return join(cwd, ".pi", "apple-music-proposals");
}

function candidateToSerializable(candidate: CandidateSong) {
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
    reasons: [...candidate.reasons, ...summarizeCandidateSignals(candidate)].slice(0, 8),
  };
}

async function writeProposalFile(
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

async function updateProposalFile(proposalPath: string, patch: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(proposalPath, "utf8")) as Record<string, unknown>;
  await writeFile(proposalPath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
}

async function resolveProposalPath(cwd: string, proposalRef?: string): Promise<string | undefined> {
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

async function loadProposal(cwd: string, proposalRef?: string): Promise<{ path: string; data: any } | undefined> {
  const path = await resolveProposalPath(cwd, proposalRef);
  if (!path) return undefined;
  return { path, data: JSON.parse(await readFile(path, "utf8")) };
}

function summarizeSkippedTracks(proposal: any, maxItems = 20): string {
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

function assistantTextContent(text: string) {
  return [{ type: "text", text }] as Array<{ type: "text"; text: string }>;
}

function appendAssistantTextMessage(pi: ExtensionAPI, _ctx: any, text: string): void {
  pi.sendMessage({
    customType: "apple-music-result",
    content: text,
    display: true,
    details: { timestamp: Date.now() },
  });
}

function splitPromptSegments(description: string): string[] {
  return unique(
    description
      .split(/[,;]+/)
      .map((part) => part.trim())
      .filter((part) => normalizeText(part).length >= 3),
  );
}

function containsNormalizedPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalizeText(text)} `;
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  return normalizedText.includes(` ${normalizedPhrase} `);
}

function hasPattern(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function detectDiscographyIntent(description: string): { discographyIntent: boolean; strictArtistOnly: boolean; targetArtist?: string } {
  const normalized = normalizeText(description);
  const discographyIntent = /(all (the )?(songs|tracks|albums)|every song|complete playlist|complete discography|discography|all available tracks|all albums|all eps|all singles)/i.test(
    description,
  );
  const strictArtistOnly = /(only songs by|only recordings by|do not include other artists|only the artist|all the .* songs)/i.test(description);

  const artistPatterns = [
    /all songs by\s+([^,.;]+)/i,
    /every song by\s+([^,.;]+)/i,
    /only songs by\s+([^,.;]+)/i,
    /only recordings by(?: the artist)?\s+([^,.;]+)/i,
    /all available tracks from\s+([^,.;]+)/i,
    /complete (?:playlist|discography)(?: of| for)?\s+([^,.;]+)/i,
    /all the\s+([^,.;]+?)\s+songs/i,
  ];

  let targetArtist: string | undefined;
  for (const pattern of artistPatterns) {
    const match = description.match(pattern);
    if (match?.[1]) {
      targetArtist = match[1].replace(/^(the artist )/i, "").trim();
      break;
    }
  }

  if (!targetArtist && discographyIntent) {
    const fallback = normalized
      .replace(/.*(?:by|of|from)\s+/, "")
      .split(/[,.;]/)[0]
      ?.trim();
    if (fallback) targetArtist = fallback;
  }

  return {
    discographyIntent,
    strictArtistOnly,
    targetArtist: targetArtist ? targetArtist.replace(/^all the\s+/i, "").trim() : undefined,
  };
}

function buildPromptFacets(description: string, matchedEntries: SeedGenreEntry[], inferredGenres: string[], moods: string[]): string[] {
  const rawSegments = splitPromptSegments(description).map((segment) => normalizeText(segment));
  const matchedFacetAliases = matchedEntries.flatMap((entry) => [entry.canonicalGenre, ...(entry.aliases ?? []).slice(0, 2)]).map(normalizeText);

  return unique([...rawSegments, ...inferredGenres.map(normalizeText), ...matchedFacetAliases, ...moods.map(normalizeText)])
    .filter(Boolean)
    .filter((facet) => facet.length >= 3)
    .slice(0, 8);
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

async function resolvePlannerModel(runtime?: PlannerRuntime): Promise<any | undefined> {
  if (!runtime?.modelRegistry) return runtime?.model;

  if (runtime.plannerModel) {
    const [provider, ...rest] = runtime.plannerModel.split("/");
    const modelId = rest.join("/").trim();
    if (provider && modelId) {
      return runtime.modelRegistry.find(provider, modelId) ?? runtime.model;
    }
  }

  const available = await runtime.modelRegistry.getAvailable();
  const preferredHaiku = available.find((model: any) => model.provider === "anthropic" && String(model.id) === "claude-haiku-4-5-20251001");
  if (preferredHaiku) return preferredHaiku;

  const preferredGptMini = available.find((model: any) => model.provider === "openai-codex" && String(model.id) === "gpt-5.4-mini");
  if (preferredGptMini) return preferredGptMini;

  return runtime.model;
}

async function getLlmPlaylistPlannerSuggestion(
  description: string,
  heuristicPlan: PlaylistPlan,
  runtime?: PlannerRuntime,
): Promise<PlaylistPlannerSuggestion | undefined> {
  if (!runtime?.modelRegistry) return undefined;

  const plannerModel = await resolvePlannerModel(runtime);
  if (!plannerModel) return undefined;

  const auth = await runtime.modelRegistry.getApiKeyAndHeaders(plannerModel);
  if (!auth.ok || !auth.apiKey) return undefined;

  const systemPrompt = `You are a music curation planner for Apple Music playlist generation.

Your job is to convert a natural language request into a compact structured curation plan.
Focus on semantic understanding, regions/scenes/cultures, vocal preferences, moods, and useful search queries.
Do not explain anything. Return JSON only.

Output JSON shape:
{
  "inferredGenres": string[],
  "facets": string[],
  "queries": string[],
  "seedArtists": string[],
  "relatedArtists": string[],
  "moods": string[],
  "avoidTerms": string[],
  "notes": string[],
  "optionalDirections": string[],
  "clarifyingQuestions": string[],
  "familiarArtists": string[],
  "discoveryIntent": boolean,
  "starterIntent": boolean,
  "broadRequest": boolean
}

Rules:
- Prefer representative artists/scenes, not generic literal title matches.
- If the request mentions countries/regions/languages, reflect that in facets, queries, and artist selection.
- If the request mentions vocals, include that in facets/notes and pick artists where vocals make sense.
- Avoid junk terms like focus frequency, brain stimulation, study tones, binaural, 432hz unless explicitly requested.
- Keep arrays short and useful.
- Queries should be good Apple Music search queries, including blended region + style queries when relevant.
- If the request is nuanced, infer adjacent genres that help curation.
- optionalDirections should capture legitimate alternate interpretations worth asking the user about.
- clarifyingQuestions should be low-friction multiple-choice style questions the user can answer quickly.
- familiarArtists should include obvious canonical artists that some users may want excluded for discovery.

Example 1 request: Chinese and Japanese lo-fi electronic music to study, concentrate and code; asian sounds, vocals okay
Example 1 output: {"inferredGenres":["Japanese Ambient","Chinese Electronic","Downtempo","Lo-Fi Beats"],"facets":["japanese","chinese","east asian","lo-fi electronic","study focus","soft vocals"],"queries":["japanese lo-fi electronic","chinese ambient electronic","east asian downtempo vocals","nujabes style japanese lo-fi","mandarin downtempo electronic"],"seedArtists":["Nujabes","Hiroshi Yoshimura","Susumu Yokota","Howie Lee","33EMYBW"],"relatedArtists":["Ryuichi Sakamoto","Haruomi Hosono","The Shanghai Restoration Project","Cornelius"],"moods":["focused","calm","textured"],"avoidTerms":["brain stimulation","432 hz","binaural"],"notes":["allow subtle vocals"],"optionalDirections":["more beat-driven lo-fi hip-hop","more ambient and textural","more traditional asian instrumental color"],"clarifyingQuestions":["Should I keep this mostly instrumental, or include more soft vocals?","Do you want more Japanese than Chinese, or a balanced mix?","Should I lean more beat-driven or more ambient?"],"familiarArtists":["Nujabes"],"discoveryIntent":false,"starterIntent":false,"broadRequest":true}

Example 2 request: ambient electronic from Icelandic and Northern European countries, with vocals
Example 2 output: {"inferredGenres":["Ambient","Dream Pop","Nordic Electronica"],"facets":["icelandic","nordic","northern european","ambient electronic","vocals"],"queries":["icelandic ambient electronic vocals","nordic dream pop electronic","scandinavian ambient pop","iceland electronic vocal"],"seedArtists":["Björk","múm","GusGus","The Knife","Röyksopp","Susanne Sundfør"],"relatedArtists":["Fever Ray","Efterklang","Karin Park","Ólafur Arnalds"],"moods":["ethereal","cold","immersive"],"avoidTerms":["meditation music","sleep sounds"],"notes":["prefer soft or art-pop vocals"],"optionalDirections":["include softer spa-adjacent nordic ambient textures","lean into art-pop / canonical nordic names","favor lesser-known discovery picks over familiar staples"],"clarifyingQuestions":["Should I include spa or thunderstorm-adjacent ambient tracks if they fit the mood?","Do you want to avoid obvious artists like Björk or Röyksopp?","Should vocals be ethereal/sparse or more song-forward?"],"familiarArtists":["Björk","Röyksopp","Fever Ray"],"discoveryIntent":false,"starterIntent":false,"broadRequest":true}`;

  const userPrompt = JSON.stringify(
    {
      request: description,
      heuristicPlan: {
        inferredGenres: heuristicPlan.inferredGenres,
        facets: heuristicPlan.facets,
        seedArtists: heuristicPlan.seedArtists,
        relatedArtists: heuristicPlan.relatedArtists,
        moods: heuristicPlan.moods,
        queries: heuristicPlan.queries,
        avoidTerms: heuristicPlan.avoidTerms,
      },
    },
    null,
    2,
  );

  const response = await complete(
    plannerModel,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userPrompt }],
          timestamp: Date.now(),
        } satisfies UserMessage,
      ],
    },
    { apiKey: auth.apiKey, headers: auth.headers },
  );

  if (response.stopReason !== "stop") return undefined;
  const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
  const json = extractJsonObject(text);
  if (!json) return undefined;

  return {
    inferredGenres: asStringArray(json.inferredGenres, 8),
    facets: asStringArray(json.facets, 10),
    queries: asStringArray(json.queries, 10),
    seedArtists: asStringArray(json.seedArtists, 12),
    relatedArtists: asStringArray(json.relatedArtists, 12),
    moods: asStringArray(json.moods, 8),
    avoidTerms: asStringArray(json.avoidTerms, 10),
    notes: asStringArray(json.notes, 6),
    optionalDirections: asStringArray(json.optionalDirections, 6),
    clarifyingQuestions: asStringArray(json.clarifyingQuestions, 4),
    familiarArtists: asStringArray(json.familiarArtists, 8),
    discoveryIntent: typeof json.discoveryIntent === "boolean" ? json.discoveryIntent : undefined,
    starterIntent: typeof json.starterIntent === "boolean" ? json.starterIntent : undefined,
    broadRequest: typeof json.broadRequest === "boolean" ? json.broadRequest : undefined,
  };
}

function mergePlaylistPlan(basePlan: PlaylistPlan, suggestion?: PlaylistPlannerSuggestion): PlaylistPlan {
  if (!suggestion) return basePlan;

  return {
    ...basePlan,
    inferredGenres: unique([...(suggestion.inferredGenres ?? []), ...basePlan.inferredGenres]).slice(0, 10),
    facets: unique([...(suggestion.facets ?? []), ...basePlan.facets]).slice(0, 10),
    queries: unique([...(suggestion.queries ?? []), ...basePlan.queries]).slice(0, 10),
    seedArtists: unique([...(suggestion.seedArtists ?? []), ...basePlan.seedArtists]).slice(0, 16),
    relatedArtists: unique([...(suggestion.relatedArtists ?? []), ...basePlan.relatedArtists]).slice(0, 16),
    moods: unique([...(suggestion.moods ?? []), ...basePlan.moods]).slice(0, 10),
    avoidTerms: unique([...(suggestion.avoidTerms ?? []), ...basePlan.avoidTerms]).map(normalizeText).filter(Boolean).slice(0, 16),
    optionalDirections: unique([...(suggestion.optionalDirections ?? []), ...basePlan.optionalDirections]).slice(0, 6),
    clarifyingQuestions: unique([...(suggestion.clarifyingQuestions ?? []), ...basePlan.clarifyingQuestions]).slice(0, 4),
    familiarArtists: unique([...(suggestion.familiarArtists ?? []), ...basePlan.familiarArtists]).slice(0, 8),
    notes: unique([...(suggestion.notes ?? []), ...basePlan.notes, "LLM-assisted plan"]).slice(0, 6),
    discoveryIntent: suggestion.discoveryIntent ?? basePlan.discoveryIntent,
    starterIntent: suggestion.starterIntent ?? basePlan.starterIntent,
    broadRequest: suggestion.broadRequest ?? basePlan.broadRequest,
    discographyIntent: basePlan.discographyIntent,
    strictArtistOnly: basePlan.strictArtistOnly,
    targetArtist: basePlan.targetArtist,
  };
}

async function buildPlaylistPlan(description: string, runtime?: PlannerRuntime): Promise<PlaylistPlan> {
  const normalizedDescription = normalizeText(description);
  const matchedEntries: SeedGenreEntry[] = [];
  const { discographyIntent, strictArtistOnly, targetArtist } = detectDiscographyIntent(description);

  for (const [genreKey, entry] of Object.entries(GENRE_SEED_MAP)) {
    const phrases = unique([genreKey, entry.canonicalGenre, ...(entry.aliases ?? [])].map(normalizeText));
    if (phrases.some((phrase) => containsNormalizedPhrase(normalizedDescription, phrase))) {
      matchedEntries.push(entry);
    }
  }

  const inferredGenres = unique(
    matchedEntries.length > 0
      ? matchedEntries.map((entry) => entry.canonicalGenre)
      : splitPromptSegments(description).slice(0, 4).map((segment) => normalizeText(segment)),
  ).filter(Boolean);

  const seedArtists = unique(matchedEntries.flatMap((entry) => entry.seedArtists)).slice(0, 12);
  const relatedArtists = unique(matchedEntries.flatMap((entry) => entry.relatedArtists)).slice(0, 12);
  const moods = unique(matchedEntries.flatMap((entry) => entry.moods ?? [])).slice(0, 8);
  const avoidTerms = unique(
    [
      ...matchedEntries.flatMap((entry) => entry.avoidTerms ?? []),
      ...inferredGenres,
      "best of",
      "workout mix",
      "meditation music",
      "study beats",
      "concentration music",
      "focus music",
      "brain stimulation",
      "432 hz",
      "binaural",
    ].map(normalizeText),
  ).filter(Boolean);

  const facets = buildPromptFacets(description, matchedEntries, inferredGenres, moods);

  const regionTerms = ["japanese", "chinese", "asian", "mandarin", "japan", "china"];
  const regionalFacets = facets.filter((facet) => regionTerms.some((term) => containsNormalizedPhrase(facet, term)));
  const styleFacets = facets.filter((facet) => !regionTerms.some((term) => containsNormalizedPhrase(facet, term)));
  const compositeRegionalQueries = regionalFacets.flatMap((regionFacet) =>
    styleFacets.slice(0, 3).map((styleFacet) => `${regionFacet} ${styleFacet}`),
  );

  const queries = unique(
    [
      normalizedDescription,
      ...compositeRegionalQueries,
      ...facets.filter((facet) => tokenize(facet).length >= 2),
      ...matchedEntries.flatMap((entry) => entry.aliases.slice(0, 2)),
      ...moods.slice(0, 3).map((mood) => `${mood} ${inferredGenres[0] ?? "music"}`),
    ]
      .map((query) => normalizeText(query))
      .filter((query) => query.length >= 3),
  ).slice(0, 10);

  const discoveryIntent = hasPattern(DISCOVERY_PATTERNS, description);
  const starterIntent = discoveryIntent || hasPattern(STARTER_PATTERNS, description);
  const broadRequest = inferredGenres.length >= 3 || (inferredGenres.length === 0 && tokenize(description).length >= 5);
  const notes = unique(matchedEntries.map((entry) => entry.notes).filter((note): note is string => Boolean(note))).slice(0, 3);

  const heuristicPlan: PlaylistPlan = {
    originalDescription: description,
    normalizedDescription,
    inferredGenres,
    matchedSeedEntries: matchedEntries,
    facets,
    queries,
    seedArtists,
    relatedArtists,
    avoidTerms,
    optionalDirections: [],
    clarifyingQuestions: [],
    familiarArtists: [],
    discographyIntent,
    strictArtistOnly,
    targetArtist,
    discoveryIntent,
    starterIntent,
    broadRequest,
    moods,
    notes,
  };

  const llmSuggestion = await getLlmPlaylistPlannerSuggestion(description, heuristicPlan, runtime);
  return mergePlaylistPlan(heuristicPlan, llmSuggestion);
}

async function searchCatalog(
  config: Required<AppleMusicConfig>,
  term: string,
  types: Array<"songs" | "artists" | "albums" | "playlists">,
  limit = 10,
): Promise<SearchResponse> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/search?term=${encodeURIComponent(term)}&types=${types.join(",")}&limit=${limit}`;
  return appleMusicRequest<SearchResponse>(path, config);
}

async function fetchArtistTopSongs(config: Required<AppleMusicConfig>, artistId: string, limit = 5): Promise<AppleMusicSong[]> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/artists/${encodeURIComponent(artistId)}/view/top-songs?limit=${limit}`;
  const response = await appleMusicRequest<TracksResponse>(path, config);
  return (response.data ?? []).filter((song) => song.type === "songs");
}

async function fetchArtistAlbums(config: Required<AppleMusicConfig>, artistId: string, limit = 100): Promise<AppleMusicAlbum[]> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/artists/${encodeURIComponent(artistId)}/albums?limit=${limit}`;
  const response = await appleMusicRequest<{ data?: AppleMusicAlbum[] }>(path, config);
  return response.data ?? [];
}

async function fetchAlbumTracks(config: Required<AppleMusicConfig>, albumId: string, limit = 6): Promise<AppleMusicSong[]> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/albums/${encodeURIComponent(albumId)}/tracks?limit=${limit}`;
  const response = await appleMusicRequest<TracksResponse>(path, config);
  return (response.data ?? []).filter((song) => song.type === "songs");
}

async function fetchPlaylistTracks(config: Required<AppleMusicConfig>, playlistId: string, limit = 12): Promise<AppleMusicSong[]> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}`;
  const response = await appleMusicRequest<TracksResponse>(path, config);
  return (response.data ?? []).filter((song) => song.type === "songs");
}

function trackCandidate(map: Map<string, CandidateSong>, song: AppleMusicSong): CandidateSong {
  const existing = map.get(song.id);
  if (existing) return existing;

  const created: CandidateSong = {
    song,
    directSongHits: 0,
    artistTopSongHits: 0,
    albumTrackHits: 0,
    playlistTrackHits: 0,
    editorialAlbumHits: 0,
    editorialPlaylistHits: 0,
    seedArtistHits: 0,
    relatedArtistHits: 0,
    queryMatches: new Set<string>(),
    genresMatched: new Set<string>(),
    facetMatches: new Set<string>(),
    reasons: new Set<string>(),
    sourceReleaseName: undefined,
    sourceReleaseType: undefined,
    score: 0,
  };
  map.set(song.id, created);
  return created;
}

function buildSongHaystack(song: AppleMusicSong): string {
  return normalizeText(
    [
      song.attributes?.name ?? "",
      song.attributes?.artistName ?? "",
      song.attributes?.albumName ?? "",
      ...(song.attributes?.genreNames ?? []),
    ].join(" "),
  );
}

function isGenericArtistName(value: string): boolean {
  const normalized = normalizeText(value);
  return /(house music dj|various artists|workout|relax|sleep|study|beats|background music|meditation)/.test(normalized);
}

function annotateFacetMatches(candidate: CandidateSong, plan: PlaylistPlan): void {
  const haystack = buildSongHaystack(candidate.song);
  for (const facet of plan.facets) {
    const normalizedFacet = normalizeText(facet);
    if (normalizedFacet && haystack.includes(normalizedFacet)) {
      candidate.facetMatches.add(facet);
    }
  }
}

function scoreCandidate(songCandidate: CandidateSong, plan: PlaylistPlan): number {
  const song = songCandidate.song;
  const title = normalizeText(song.attributes?.name ?? "");
  const artist = normalizeText(song.attributes?.artistName ?? "");
  const haystack = buildSongHaystack(song);

  let score = 0;
  score += songCandidate.directSongHits * 8;
  score += songCandidate.artistTopSongHits * 20;
  score += songCandidate.albumTrackHits * 8;
  score += songCandidate.playlistTrackHits * 14;
  score += songCandidate.editorialAlbumHits * 12;
  score += songCandidate.editorialPlaylistHits * 10;
  score += songCandidate.seedArtistHits * 36;
  score += songCandidate.relatedArtistHits * 18;
  score += songCandidate.queryMatches.size * 4;
  score += songCandidate.genresMatched.size * 8;
  score += songCandidate.facetMatches.size * 10;

  for (const genre of plan.inferredGenres) {
    const normalizedGenre = normalizeText(genre);
    if (artist === normalizedGenre) score -= 40;
    if (title === normalizedGenre) score -= 65;
    if (haystack.includes(normalizedGenre)) score += 2;
  }

  for (const avoidTerm of plan.avoidTerms) {
    if (!avoidTerm) continue;
    if (title === avoidTerm) score -= 75;
    else if (title.includes(avoidTerm) && title.length <= avoidTerm.length + 10) score -= 25;
  }

  if (isGenericArtistName(song.attributes?.artistName ?? "")) score -= 70;
  if ((song.attributes?.genreNames ?? []).length > 0) score += 3;
  if (plan.discoveryIntent || plan.starterIntent) score += songCandidate.seedArtistHits > 0 ? 10 : 0;
  if (songCandidate.playlistTrackHits > 0 && songCandidate.artistTopSongHits > 0) score += 8;
  if (plan.facets.length > 1 && songCandidate.facetMatches.size >= 2) score += 10;
  if (songCandidate.editorialPlaylistHits > 0 && songCandidate.editorialAlbumHits > 0) score += 14;
  if (songCandidate.editorialPlaylistHits >= 2) score += 10;

  return score;
}

function summarizeCandidateSignals(candidate: CandidateSong): string[] {
  const signals: string[] = [];
  if (candidate.editorialPlaylistHits > 0 || candidate.editorialAlbumHits > 0) {
    signals.push(`editorial support: ${candidate.editorialPlaylistHits} playlists, ${candidate.editorialAlbumHits} albums`);
  }
  if (candidate.facetMatches.size > 0) {
    signals.push(`facet matches: ${[...candidate.facetMatches].slice(0, 4).join(", ")}`);
  }
  if (candidate.seedArtistHits > 0) {
    signals.push(`seed artist support: ${candidate.seedArtistHits}`);
  }
  return signals;
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffleWithRng<T>(values: T[], rng: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function shuffleWithinScoreBands(candidates: CandidateSong[], rng: () => number, bandSize = 6): CandidateSong[] {
  const bands: CandidateSong[][] = [];

  for (const candidate of candidates) {
    const band = bands[bands.length - 1];
    if (!band || band[0].score - candidate.score > bandSize) {
      bands.push([candidate]);
      continue;
    }
    band.push(candidate);
  }

  return bands.flatMap((band) => shuffleWithRng(band, rng));
}

function candidatePrimaryGenre(candidate: CandidateSong): string {
  return normalizeText(candidate.song.attributes?.genreNames?.[0] ?? "");
}

function canonicalizeTrackTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(([^)]*(radio edit|extended mix|extended version|club mix|dub mix|mix|remix|edit|version|live|instrumental|acoustic|remaster(?:ed)?)[^)]*)\)/g, " ")
    .replace(/\[([^\]]*(radio edit|extended mix|extended version|club mix|dub mix|mix|remix|edit|version|live|instrumental|acoustic|remaster(?:ed)?)[^\]]*)\]/g, " ")
    .replace(/[-–—]\s*(radio edit|extended mix|extended version|club mix|dub mix|mix|remix|edit|version|live|instrumental|acoustic|remaster(?:ed)?).*$/g, " ")
    .replace(/\b(feat\.?|featuring|ft\.?)\b.*$/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTrackSignature(candidate: CandidateSong): string {
  return canonicalizeTrackTitle(candidate.song.attributes?.name ?? "");
}

function classifyReleaseType(releaseName: string): "album" | "ep" | "single" | "other" {
  const normalized = normalizeText(releaseName);
  if (/\bep\b/.test(normalized)) return "ep";
  if (/\bsingle\b/.test(normalized)) return "single";
  return normalized ? "album" : "other";
}

function hasVersionMarker(title: string): boolean {
  return /(live|acoustic|alternate|alt\b|remix|version|session|demo|instrumental|piano solo|duet|edit)/i.test(title);
}

function shouldIncludeAllSingles(plan: PlaylistPlan): boolean {
  return /all singles|include singles|keep singles/.test(plan.normalizedDescription);
}

function shouldIncludeAlternateVersions(plan: PlaylistPlan): boolean {
  return /live|acoustic|alternate|remix|version|session|demo|instrumental|duet/.test(plan.normalizedDescription);
}

function songArtistIncludesTarget(songArtistName: string, targetArtistName: string): boolean {
  const normalizedSongArtist = normalizeText(songArtistName);
  const normalizedTargetArtist = normalizeText(targetArtistName);
  if (!normalizedSongArtist || !normalizedTargetArtist) return false;
  if (normalizedSongArtist === normalizedTargetArtist) return true;

  const artistParts = normalizedSongArtist
    .split(/,|&| feat\.? | featuring | with /)
    .map((part) => part.trim())
    .filter(Boolean);
  return artistParts.includes(normalizedTargetArtist);
}

function canSelectCandidate(
  candidate: CandidateSong,
  selected: CandidateSong[],
  artistCounts: Map<string, number>,
  albumCounts: Map<string, number>,
  seenTrackSignatures: Set<string>,
  maxPerArtist: number,
  maxPerAlbum: number,
  enforceSequentialGenreDiversity: boolean,
): boolean {
  const artist = candidate.song.attributes?.artistName ?? "Unknown artist";
  const album = candidate.song.attributes?.albumName ?? "Unknown album";
  const signature = canonicalTrackSignature(candidate);
  if (signature && seenTrackSignatures.has(signature)) return false;
  if ((artistCounts.get(artist) ?? 0) >= maxPerArtist) return false;
  if ((albumCounts.get(album) ?? 0) >= maxPerAlbum) return false;

  if (enforceSequentialGenreDiversity && selected.length > 0) {
    const previousGenre = candidatePrimaryGenre(selected[selected.length - 1]);
    const currentGenre = candidatePrimaryGenre(candidate);
    if (previousGenre && currentGenre && previousGenre === currentGenre) return false;
  }

  return true;
}

function weightedPickIndex(candidates: CandidateSong[], rng: () => number): number {
  const floor = Math.min(...candidates.map((candidate) => candidate.score));
  const totalWeight = candidates.reduce((sum, candidate) => sum + Math.max(1, candidate.score - floor + 1), 0);
  let target = rng() * totalWeight;

  for (let index = 0; index < candidates.length; index += 1) {
    target -= Math.max(1, candidates[index].score - floor + 1);
    if (target <= 0) return index;
  }

  return candidates.length - 1;
}

function buildMajorFacets(plan: PlaylistPlan, trackCount: number): string[] {
  return plan.facets.filter((facet) => facet.length >= 3).slice(0, Math.min(4, trackCount));
}

function buildFacetTargets(plan: PlaylistPlan, trackCount: number): Map<string, number> {
  const meaningfulFacets = buildMajorFacets(plan, trackCount);
  if (meaningfulFacets.length <= 1) return new Map();

  const baseTarget = Math.max(1, Math.floor(trackCount / meaningfulFacets.length));
  return new Map(meaningfulFacets.map((facet) => [facet, baseTarget]));
}

function findUncoveredMajorFacets(plan: PlaylistPlan, selected: CandidateSong[], trackCount: number): string[] {
  const covered = new Set(selected.flatMap((candidate) => [...candidate.facetMatches]));
  return buildMajorFacets(plan, trackCount).filter((facet) => !covered.has(facet));
}

function buildDiscographySelection(
  candidates: CandidateSong[],
  plan: PlaylistPlan,
): { selectedCandidates: CandidateSong[]; skippedCandidates: Array<CandidateSong & { skipReason: string }> } {
  const includeAllSingles = shouldIncludeAllSingles(plan);
  const includeAlternateVersions = shouldIncludeAlternateVersions(plan);
  const selected: CandidateSong[] = [];
  const skipped: Array<CandidateSong & { skipReason: string }> = [];
  const selectedIds = new Set<string>();
  const coreSignatures = new Set<string>();

  const pushSelected = (candidate: CandidateSong) => {
    if (selectedIds.has(candidate.song.id)) return;
    selected.push(candidate);
    selectedIds.add(candidate.song.id);
  };

  const byReleaseType = (releaseType: "album" | "ep" | "single" | "other") =>
    candidates.filter((candidate) => (candidate.sourceReleaseType ?? "other") === releaseType);

  for (const candidate of [...byReleaseType("album"), ...byReleaseType("ep")]) {
    pushSelected(candidate);
    coreSignatures.add(canonicalTrackSignature(candidate));
  }

  for (const candidate of [...byReleaseType("single"), ...byReleaseType("other")]) {
    const signature = canonicalTrackSignature(candidate);
    const isAlternate = hasVersionMarker(candidate.song.attributes?.name ?? "") || hasVersionMarker(candidate.sourceReleaseName ?? "");
    if (!includeAllSingles && coreSignatures.has(signature) && (!includeAlternateVersions || !isAlternate)) {
      skipped.push({ ...candidate, skipReason: isAlternate ? "alternate-single-excluded" : "single-duplicate-of-album-or-ep" });
      continue;
    }
    if (coreSignatures.has(signature) && isAlternate && !includeAlternateVersions) {
      skipped.push({ ...candidate, skipReason: "alternate-version-excluded" });
      continue;
    }
    pushSelected(candidate);
  }

  return { selectedCandidates: selected, skippedCandidates: skipped };
}

function selectPlaylistSongs(candidates: CandidateSong[], trackCount: number, seedKey: string, plan: PlaylistPlan): CandidateSong[] {
  const maxPerArtist = trackCount <= 15 ? 1 : trackCount >= 30 ? 3 : 2;
  const maxPerAlbum = trackCount <= 20 ? 1 : 2;
  const rng = createSeededRng(hashSeed(seedKey));
  const ranked = shuffleWithinScoreBands(candidates, rng);
  const initialPoolSize = clamp(Math.max(trackCount * 3, 30), trackCount, ranked.length);
  const targetSelectionCount = clamp(Math.max(trackCount + 15, Math.ceil(trackCount * 1.8)), trackCount, ranked.length);
  const preliminary: CandidateSong[] = [];
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const seenTrackSignatures = new Set<string>();
  const facetTargets = buildFacetTargets(plan, trackCount);
  const facetCounts = new Map<string, number>();
  const available = [...ranked.slice(0, initialPoolSize)];
  const fallback = [...ranked.slice(initialPoolSize)];

  const takePreliminaryCandidate = (candidate: CandidateSong) => {
    preliminary.push(candidate);
    const artist = candidate.song.attributes?.artistName ?? "Unknown artist";
    const album = candidate.song.attributes?.albumName ?? "Unknown album";
    const signature = canonicalTrackSignature(candidate);
    if (signature) seenTrackSignatures.add(signature);
    for (const facet of candidate.facetMatches) {
      if (facetTargets.has(facet)) {
        facetCounts.set(facet, (facetCounts.get(facet) ?? 0) + 1);
      }
    }
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    albumCounts.set(album, (albumCounts.get(album) ?? 0) + 1);
  };

  while (preliminary.length < targetSelectionCount && (available.length > 0 || fallback.length > 0)) {
    if (available.length === 0 && fallback.length > 0) {
      available.push(...fallback.splice(0, Math.max(5, targetSelectionCount - preliminary.length)));
    }

    const neededFacets = [...facetTargets.entries()]
      .filter(([facet, target]) => (facetCounts.get(facet) ?? 0) < target)
      .map(([facet]) => facet);

    let eligible = available.filter((candidate) =>
      canSelectCandidate(candidate, preliminary, artistCounts, albumCounts, seenTrackSignatures, maxPerArtist, maxPerAlbum, true),
    );
    if (neededFacets.length > 0) {
      const facetEligible = eligible.filter((candidate) => neededFacets.some((facet) => candidate.facetMatches.has(facet)));
      if (facetEligible.length > 0) eligible = facetEligible;
    }
    if (eligible.length === 0) {
      eligible = available.filter((candidate) =>
        canSelectCandidate(candidate, preliminary, artistCounts, albumCounts, seenTrackSignatures, maxPerArtist, maxPerAlbum, false),
      );
    }
    if (eligible.length === 0) {
      eligible = available.filter((candidate) => {
        const artist = candidate.song.attributes?.artistName ?? "Unknown artist";
        const signature = canonicalTrackSignature(candidate);
        return !seenTrackSignatures.has(signature) && (artistCounts.get(artist) ?? 0) < maxPerArtist;
      });
    }
    if (eligible.length === 0) {
      eligible = [...available];
    }
    if (eligible.length === 0) break;

    const picked = eligible[weightedPickIndex(eligible, rng)];
    const pickedIndex = available.findIndex((candidate) => candidate.song.id === picked.song.id);
    if (pickedIndex >= 0) available.splice(pickedIndex, 1);
    takePreliminaryCandidate(picked);
  }

  const finalized: CandidateSong[] = [];
  const seenSignatures = new Set<string>();
  const finalizedFacetCounts = new Map<string, number>();
  const majorFacets = buildMajorFacets(plan, trackCount);
  const preliminaryIds = new Set(preliminary.map((candidate) => candidate.song.id));
  const finalizeFrom = [...preliminary, ...ranked.filter((candidate) => !preliminaryIds.has(candidate.song.id))];

  const tryAddFinalCandidate = (candidate: CandidateSong): boolean => {
    const signature = canonicalTrackSignature(candidate);
    if (seenSignatures.has(signature)) return false;
    finalized.push(candidate);
    seenSignatures.add(signature);
    for (const facet of candidate.facetMatches) {
      if (facetTargets.has(facet)) {
        finalizedFacetCounts.set(facet, (finalizedFacetCounts.get(facet) ?? 0) + 1);
      }
    }
    return true;
  };

  for (const facet of majorFacets) {
    if (finalized.length >= trackCount) break;
    if ((finalizedFacetCounts.get(facet) ?? 0) > 0) continue;
    const representative = finalizeFrom.find((candidate) => !seenSignatures.has(canonicalTrackSignature(candidate)) && candidate.facetMatches.has(facet));
    if (representative) tryAddFinalCandidate(representative);
  }

  for (const facet of [...facetTargets.keys()]) {
    const target = facetTargets.get(facet) ?? 0;
    while ((finalizedFacetCounts.get(facet) ?? 0) < target && finalized.length < trackCount) {
      const match = finalizeFrom.find((candidate) => !seenSignatures.has(canonicalTrackSignature(candidate)) && candidate.facetMatches.has(facet));
      if (!match) break;
      tryAddFinalCandidate(match);
    }
  }

  for (const candidate of finalizeFrom) {
    if (finalized.length >= trackCount) break;
    tryAddFinalCandidate(candidate);
  }

  return finalized;
}

async function collectDirectSongCandidates(
  config: Required<AppleMusicConfig>,
  plan: PlaylistPlan,
  candidates: Map<string, CandidateSong>,
): Promise<void> {
  for (const query of plan.queries) {
    const response = await searchCatalog(config, query, ["songs"], 10);
    for (const song of response.results?.songs?.data ?? []) {
      const candidate = trackCandidate(candidates, song);
      annotateFacetMatches(candidate, plan);
      candidate.directSongHits += 1;
      candidate.queryMatches.add(query);
      candidate.reasons.add(`song search: ${query}`);
      for (const genre of plan.inferredGenres) {
        if (buildSongHaystack(song).includes(normalizeText(genre))) {
          candidate.genresMatched.add(genre);
        }
      }
    }
  }
}

async function collectArtistCandidates(
  config: Required<AppleMusicConfig>,
  plan: PlaylistPlan,
  candidates: Map<string, CandidateSong>,
): Promise<void> {
  const artistNames = unique([...plan.seedArtists, ...plan.relatedArtists]).slice(0, 10);
  for (const artistName of artistNames) {
    const response = await searchCatalog(config, artistName, ["artists"], 3);
    const artist = (response.results?.artists?.data ?? [])[0];
    if (!artist?.id) continue;
    const topSongs = await fetchArtistTopSongs(config, artist.id, plan.discoveryIntent || plan.starterIntent ? 6 : 4);
    for (const song of topSongs) {
      const candidate = trackCandidate(candidates, song);
      annotateFacetMatches(candidate, plan);
      candidate.artistTopSongHits += 1;
      if (plan.seedArtists.includes(artistName)) {
        candidate.seedArtistHits += 1;
        candidate.reasons.add(`seed artist: ${artistName}`);
      } else {
        candidate.relatedArtistHits += 1;
        candidate.reasons.add(`related artist: ${artistName}`);
      }
    }
  }
}

function isEditorialPlaylist(playlist: AppleMusicPlaylist): boolean {
  const curator = normalizeText(playlist.attributes?.curatorName ?? "");
  return curator.includes("apple music") || Boolean(playlist.attributes?.editorialNotes?.standard || playlist.attributes?.description?.standard);
}

function isEditorialAlbum(album: AppleMusicAlbum): boolean {
  return Boolean(album.attributes?.editorialNotes?.standard || album.attributes?.editorialNotes?.short);
}

async function collectAlbumCandidates(
  config: Required<AppleMusicConfig>,
  plan: PlaylistPlan,
  candidates: Map<string, CandidateSong>,
): Promise<void> {
  for (const query of plan.queries.slice(0, 5)) {
    const response = await searchCatalog(config, query, ["albums"], 4);
    for (const album of response.results?.albums?.data ?? []) {
      if (!album.id) continue;
      const editorial = isEditorialAlbum(album);
      const tracks = await fetchAlbumTracks(config, album.id, editorial ? 6 : 5);
      for (const song of tracks) {
        const candidate = trackCandidate(candidates, song);
        annotateFacetMatches(candidate, plan);
        candidate.albumTrackHits += 1;
        if (editorial) candidate.editorialAlbumHits += 1;
        candidate.queryMatches.add(query);
        candidate.reasons.add(`${editorial ? "editorial album" : "album signal"}: ${album.attributes?.name ?? query}`);
      }
    }
  }
}

async function collectPlaylistCandidates(
  config: Required<AppleMusicConfig>,
  plan: PlaylistPlan,
  candidates: Map<string, CandidateSong>,
): Promise<void> {
  for (const query of plan.queries.slice(0, 5)) {
    const response = await searchCatalog(config, query, ["playlists"], 4);
    for (const playlist of response.results?.playlists?.data ?? []) {
      if (!playlist.id) continue;
      const tracks = await fetchPlaylistTracks(config, playlist.id, plan.discoveryIntent || plan.starterIntent ? 14 : 10);
      const editorial = isEditorialPlaylist(playlist);
      for (const song of tracks) {
        const candidate = trackCandidate(candidates, song);
        annotateFacetMatches(candidate, plan);
        candidate.playlistTrackHits += 1;
        if (editorial) candidate.editorialPlaylistHits += 1;
        candidate.queryMatches.add(query);
        candidate.reasons.add(
          `${editorial ? "editorial playlist" : "playlist"}: ${playlist.attributes?.name ?? query}${playlist.attributes?.curatorName ? ` (${playlist.attributes.curatorName})` : ""}`,
        );
      }
    }
  }
}

async function collectDiscographyCandidates(
  config: Required<AppleMusicConfig>,
  plan: PlaylistPlan,
  candidates: Map<string, CandidateSong>,
): Promise<void> {
  if (!plan.targetArtist) return;

  const response = await searchCatalog(config, plan.targetArtist, ["artists"], 5);
  const normalizedTarget = normalizeText(plan.targetArtist);
  const artist = (response.results?.artists?.data ?? []).find((item) => normalizeText(item.attributes?.name ?? "") === normalizedTarget) ??
    (response.results?.artists?.data ?? [])[0];
  if (!artist?.id) return;

  const artistName = artist.attributes?.name ?? plan.targetArtist;
  const strictPrimaryArtistOnly = plan.strictArtistOnly;
  const albums = await fetchArtistAlbums(config, artist.id, 100);
  for (const album of albums) {
    if (!album.id) continue;
    const tracks = await fetchAlbumTracks(config, album.id, 100);
    for (const song of tracks) {
      const songArtistName = song.attributes?.artistName ?? "";
      if (strictPrimaryArtistOnly && normalizeText(songArtistName) !== normalizeText(artistName)) continue;
      if (!strictPrimaryArtistOnly && !songArtistIncludesTarget(songArtistName, artistName)) continue;
      const candidate = trackCandidate(candidates, song);
      annotateFacetMatches(candidate, plan);
      candidate.albumTrackHits += 3;
      candidate.seedArtistHits += 2;
      candidate.queryMatches.add(plan.targetArtist);
      candidate.sourceReleaseName ??= album.attributes?.name ?? song.attributes?.albumName;
      candidate.sourceReleaseType ??= classifyReleaseType(album.attributes?.name ?? song.attributes?.albumName ?? "");
      candidate.reasons.add(`discography: ${artistName}`);
    }
  }

  const topSongs = await fetchArtistTopSongs(config, artist.id, 50);
  for (const song of topSongs) {
    const songArtistName = song.attributes?.artistName ?? "";
    if (strictPrimaryArtistOnly && normalizeText(songArtistName) !== normalizeText(artistName)) continue;
    if (!strictPrimaryArtistOnly && !songArtistIncludesTarget(songArtistName, artistName)) continue;
    const candidate = trackCandidate(candidates, song);
    annotateFacetMatches(candidate, plan);
    candidate.artistTopSongHits += 2;
    candidate.seedArtistHits += 2;
    candidate.queryMatches.add(plan.targetArtist);
    candidate.sourceReleaseName ??= song.attributes?.albumName;
    candidate.sourceReleaseType ??= classifyReleaseType(song.attributes?.albumName ?? "");
    candidate.reasons.add(`artist catalog: ${artistName}`);
  }
}

async function curateSongs(
  config: Required<AppleMusicConfig>,
  description: string,
  runtime?: PlannerRuntime,
): Promise<{ plan: PlaylistPlan; candidates: CandidateSong[] }> {
  const plan = await buildPlaylistPlan(description, runtime);
  const candidates = new Map<string, CandidateSong>();

  if (plan.discographyIntent && plan.targetArtist) {
    await collectDiscographyCandidates(config, plan, candidates);
  } else {
    await collectDirectSongCandidates(config, plan, candidates);
    await collectArtistCandidates(config, plan, candidates);
    await collectAlbumCandidates(config, plan, candidates);
    await collectPlaylistCandidates(config, plan, candidates);
  }

  const ranked = [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, plan) + (plan.discographyIntent ? 1000 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  return { plan, candidates: ranked };
}

async function fetchLibraryPlaylistFolders(config: Required<AppleMusicConfig>, limit = 100): Promise<LibraryPlaylistFolder[]> {
  const response = await appleMusicRequest<LibraryPlaylistFoldersResponse>(`/v1/me/library/playlist-folders?limit=${limit}`, config);
  return response.data ?? [];
}

async function createLibraryPlaylistFolder(config: Required<AppleMusicConfig>, name: string): Promise<LibraryPlaylistFolder> {
  const response = await appleMusicRequest<LibraryPlaylistFoldersResponse>("/v1/me/library/playlist-folders", config, {
    method: "POST",
    body: JSON.stringify({
      attributes: {
        name,
      },
    }),
  });

  const folder = response.data?.[0];
  if (!folder?.id) {
    throw new Error("Apple Music did not return a playlist folder id.");
  }
  return folder;
}

async function findOrCreateLibraryPlaylistFolderId(config: Required<AppleMusicConfig>, name: string): Promise<string | undefined> {
  const cacheKey = normalizeText(name);
  const cached = PLAYLIST_FOLDER_ID_CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    const existing = (await fetchLibraryPlaylistFolders(config)).find((folder) => normalizeText(folder.attributes?.name ?? "") === cacheKey);
    if (existing?.id) {
      PLAYLIST_FOLDER_ID_CACHE.set(cacheKey, existing.id);
      return existing.id;
    }

    const created = await createLibraryPlaylistFolder(config, name);
    PLAYLIST_FOLDER_ID_CACHE.set(cacheKey, created.id);
    return created.id;
  } catch {
    return undefined;
  }
}

async function createPlaylist(
  config: Required<AppleMusicConfig>,
  name: string,
  description: string,
  songs: AppleMusicSong[],
  parentFolderId?: string,
): Promise<{ id: string; songs: AppleMusicSong[] }> {
  const createResponse = await appleMusicRequest<CreatePlaylistResponse>("/v1/me/library/playlists", config, {
    method: "POST",
    body: JSON.stringify({
      attributes: {
        name,
        description,
      },
      ...(parentFolderId
        ? {
            relationships: {
              parent: {
                data: [{ id: parentFolderId, type: "library-playlist-folders" }],
              },
            },
          }
        : {}),
    }),
  });

  const playlistId = createResponse.data?.[0]?.id;
  if (!playlistId) {
    throw new Error("Apple Music did not return a playlist id.");
  }

  await appleMusicRequest(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, config, {
    method: "POST",
    body: JSON.stringify({
      data: songs.map((song) => ({ id: song.id, type: "songs" })),
    }),
  });

  return { id: playlistId, songs };
}

async function runAppleScript(pi: ExtensionAPI, lines: string[]): Promise<string> {
  if (!isMacOS()) {
    throw new Error("Local Apple Music control currently requires macOS.");
  }

  const args = lines.flatMap((line) => ["-e", line]);
  const result = await pi.exec("osascript", args);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "osascript failed");
  }
  return result.stdout.trim();
}

function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensurePlaylistFolder(pi: ExtensionAPI, folderName = APPLE_MUSIC_FOLDER_NAME): Promise<void> {
  const name = esc(folderName);
  await runAppleScript(pi, [
    'tell application "Music"',
    `if not (exists folder playlist "${name}") then`,
    `make new folder playlist with properties {name:"${name}"}`,
    "end if",
    'end tell',
  ]);
}

async function movePlaylistToFolder(
  pi: ExtensionAPI,
  playlistName: string,
  folderName = APPLE_MUSIC_FOLDER_NAME,
  options?: { attempts?: number; delayMs?: number; initialDelayMs?: number },
): Promise<boolean> {
  const playlist = esc(playlistName);
  const folder = esc(folderName);
  const attempts = Math.max(1, options?.attempts ?? APPLE_MUSIC_MOVE_ATTEMPTS);
  const delayMs = Math.max(0, options?.delayMs ?? APPLE_MUSIC_MOVE_RETRY_DELAY_MS);
  const initialDelayMs = Math.max(0, options?.initialDelayMs ?? APPLE_MUSIC_MOVE_INITIAL_DELAY_MS);

  if (initialDelayMs > 0) {
    await delay(initialDelayMs);
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const output = await runAppleScript(pi, [
      'tell application "Music"',
      `if not (exists folder playlist "${folder}") then`,
      `make new folder playlist with properties {name:"${folder}"}`,
      "end if",
      `if exists user playlist "${playlist}" then`,
      `set targetPlaylist to first user playlist whose name is "${playlist}"`,
      `move targetPlaylist to folder playlist "${folder}"`,
      'return "moved"',
      "end if",
      'return "missing"',
      'end tell',
    ]);

    if (output === "moved") return true;
    if (attempt < attempts - 1) await delay(delayMs);
  }

  return false;
}

async function transport(pi: ExtensionAPI, action: (typeof TRANSPORT_ACTIONS)[number], options?: { playlistName?: string; volume?: number }) {
  switch (action) {
    case "play":
      await runAppleScript(pi, ['tell application "Music" to play']);
      return "Apple Music is playing.";
    case "pause":
      await runAppleScript(pi, ['tell application "Music" to pause']);
      return "Apple Music is paused.";
    case "playpause":
      await runAppleScript(pi, ['tell application "Music" to playpause']);
      return "Toggled Apple Music play/pause.";
    case "next":
      await runAppleScript(pi, ['tell application "Music" to next track']);
      return "Skipped to the next track.";
    case "previous":
      await runAppleScript(pi, ['tell application "Music" to previous track']);
      return "Went back to the previous track.";
    case "stop":
      await runAppleScript(pi, ['tell application "Music" to stop']);
      return "Stopped Apple Music playback.";
    case "shuffle_on":
      await runAppleScript(pi, ['tell application "Music" to set shuffle enabled to true']);
      return "Shuffle is on.";
    case "shuffle_off":
      await runAppleScript(pi, ['tell application "Music" to set shuffle enabled to false']);
      return "Shuffle is off.";
    case "shuffle_toggle": {
      const output = await runAppleScript(pi, [
        'tell application "Music"',
        'set shuffle enabled to not shuffle enabled',
        'return shuffle enabled as text',
        'end tell',
      ]);
      return `Shuffle is now ${output}.`;
    }
    case "repeat_off":
      await runAppleScript(pi, ['tell application "Music" to set song repeat to off']);
      return "Repeat is off.";
    case "repeat_one":
      await runAppleScript(pi, ['tell application "Music" to set song repeat to one']);
      return "Repeat is set to one.";
    case "repeat_all":
      await runAppleScript(pi, ['tell application "Music" to set song repeat to all']);
      return "Repeat is set to all.";
    case "set_volume": {
      const volume = clamp(Math.round(options?.volume ?? 50), 0, 100);
      await runAppleScript(pi, [`tell application "Music" to set sound volume to ${volume}`]);
      return `Volume set to ${volume}.`;
    }
    case "play_playlist": {
      if (!options?.playlistName) throw new Error("playlistName is required for play_playlist.");
      const name = esc(options.playlistName);
      const folder = esc(APPLE_MUSIC_FOLDER_NAME);
      await runAppleScript(pi, [
        'tell application "Music"',
        'set targetPlaylist to missing value',
        `if exists user playlist "${name}" then`,
        `set targetPlaylist to first user playlist whose name is "${name}"`,
        `else if (exists folder playlist "${folder}") and (exists (first user playlist of folder playlist "${folder}" whose name is "${name}")) then`,
        `set targetPlaylist to first user playlist of folder playlist "${folder}" whose name is "${name}"`,
        'else',
        'error "Playlist not found."',
        'end if',
        'play targetPlaylist',
        'end tell',
      ]);
      return `Playing playlist \"${options.playlistName}\".`;
    }
    case "status": {
      const output = await runAppleScript(pi, [
        'tell application "Music"',
        'set trackName to ""',
        'set artistName to ""',
        'set albumName to ""',
        'if (player state is playing) or (player state is paused) then',
        'set currentSong to current track',
        'set trackName to name of currentSong',
        'set artistName to artist of currentSong',
        'set albumName to album of currentSong',
        'end if',
        'return (player state as text) & "||" & (sound volume as text) & "||" & trackName & "||" & artistName & "||" & albumName',
        'end tell',
      ]);
      const [state = "unknown", volume = "", track = "", artist = "", album = ""] = output.split("||");
      const parts = [`State: ${state}`];
      if (volume) parts.push(`Volume: ${volume}`);
      if (track) parts.push(`Track: ${track}`);
      if (artist) parts.push(`Artist: ${artist}`);
      if (album) parts.push(`Album: ${album}`);
      return parts.join("\n");
    }
  }
}

function buildPreviewCacheKey(params: { description: string; playlistName?: string; trackCount?: number }): string {
  return `${normalizeText(params.description)}::${normalizeText(params.playlistName ?? "")}::${Math.round(params.trackCount ?? 25)}`;
}

async function buildCuratedPlaylistPreview(
  config: Required<AppleMusicConfig>,
  params: { description: string; playlistName?: string; trackCount?: number; selectionSeed?: string },
  runtime?: PlannerRuntime,
) {
  const { plan, candidates } = await curateSongs(config, params.description, runtime);
  if (candidates.length === 0) {
    throw new Error(`No Apple Music songs matched: ${params.description}`);
  }

  const requestedTrackCount = Math.round(params.trackCount ?? (plan.discographyIntent ? candidates.length : 25));
  const trackCount = Math.max(5, requestedTrackCount);
  const selectionSeed = params.selectionSeed ?? `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  const selectionSeedKey = `${params.description}::${params.playlistName ?? ""}::${trackCount}::${selectionSeed}`;
  const discographySelection = plan.discographyIntent ? buildDiscographySelection(candidates, plan) : undefined;
  const selectedCandidates = discographySelection?.selectedCandidates ?? selectPlaylistSongs(candidates, trackCount, selectionSeedKey, plan);
  if (selectedCandidates.length === 0) {
    throw new Error(`No Apple Music songs matched: ${params.description}`);
  }

  const selected = selectedCandidates.map((candidate) => candidate.song);
  const playlistName = (params.playlistName?.trim() || derivePlaylistName(params.description)).slice(0, 100);
  const playlistDescription = buildStoredPlaylistDescription(params.description, plan, selectionSeed);
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.song.id));
  const skippedCandidates = discographySelection?.skippedCandidates ?? candidates.filter((candidate) => !selectedIds.has(candidate.song.id)).map((candidate) => ({
    ...candidate,
    skipReason: plan.discographyIntent ? "not-selected-for-final-playlist" : "not-selected-after-ranking",
  }));

  let proposalId: string | undefined;
  let proposalPath: string | undefined;
  if (runtime?.cwd) {
    const persisted = await writeProposalFile(runtime.cwd, {
      type: "apple-music-playlist-proposal",
      createdAt: new Date().toISOString(),
      description: params.description,
      playlistName,
      playlistDescription,
      trackCount,
      selectionSeed,
      plan,
      counts: {
        candidateCount: candidates.length,
        selectedCount: selectedCandidates.length,
        skippedCount: skippedCandidates.length,
      },
      selectedTracks: selectedCandidates.map(candidateToSerializable),
      skippedTracks: skippedCandidates.map((candidate) => ({ ...candidateToSerializable(candidate), skipReason: candidate.skipReason })),
    });
    proposalId = persisted.proposalId;
    proposalPath = persisted.proposalPath;
  }

  return {
    plan,
    trackCount,
    selectedCandidates,
    skippedCandidates,
    selected,
    playlistName,
    playlistDescription,
    selectionSeed,
    proposalId,
    proposalPath,
  };
}

async function previewCuratedPlaylist(
  config: Required<AppleMusicConfig>,
  params: { description: string; playlistName?: string; trackCount?: number; selectionSeed?: string },
  runtime?: PlannerRuntime,
) {
  const previewData = await buildCuratedPlaylistPreview(config, params, runtime);
  PREVIEW_PROPOSAL_CACHE.set(buildPreviewCacheKey(params), previewData);
  const { plan, trackCount, selected, selectedCandidates, playlistName } = previewData;
  const uncoveredMajorFacets = findUncoveredMajorFacets(plan, selectedCandidates, trackCount);
  const previewDisplayCount = Math.min(25, selected.length);
  const preview = selected.slice(0, previewDisplayCount).map((song, index) => `${index + 1}. ${songLabel(song)}`).join("\n");
  const highConfidencePreview = selected.slice(0, 10).map((song, index) => `${index + 1}. ${songLabel(song)}`).join("\n");
  const collaborationCount = plan.targetArtist
    ? selectedCandidates.filter((candidate) => normalizeText(candidate.song.attributes?.artistName ?? "") !== normalizeText(plan.targetArtist ?? "")).length
    : 0;
  const planSummary = [
    `Proposed playlist: \"${playlistName}\"`,
    plan.discographyIntent ? `Selected tracks: ${selectedCandidates.length}` : `Tracks: ${trackCount}`,
    plan.discographyIntent && previewData.skippedCandidates.length > 0 ? `Skipped tracks: ${previewData.skippedCandidates.length} (saved in proposal JSON)` : "",
    plan.discographyIntent && selected.length > previewDisplayCount ? `Showing first ${previewDisplayCount} of ${selected.length} tracks below` : "",
    plan.inferredGenres.length > 0 ? `Genres: ${plan.inferredGenres.join(", ")}` : "",
    plan.facets.length > 1 ? `Facets: ${plan.facets.slice(0, 5).join(", ")}` : "",
    plan.seedArtists.length > 0 ? `Seed artists: ${plan.seedArtists.slice(0, 6).join(", ")}` : "",
    plan.discographyIntent && plan.targetArtist ? `Discography mode: ${plan.strictArtistOnly ? "primary-artist tracks only" : `includes collaborations/features by default (${collaborationCount} in current selection)`}` : "",
    plan.discoveryIntent || plan.starterIntent ? "Mode: discovery / starter" : "",
  ]
    .filter(Boolean)
    .join("\n");

  const discographyQuestions = plan.discographyIntent
    ? [
        !plan.strictArtistOnly ? "Keep collaborations/features included, or switch to primary-artist tracks only?" : "Do you also want collaborations/features included?",
        "Include live/acoustic/alternate/remix versions if available?",
        "Sort chronologically or group by album?",
      ]
    : [];

  const collaborativeSections = [
    plan.optionalDirections.length > 0 ? `Possible directions I found:\n${formatBulletList(plan.optionalDirections.slice(0, 3))}` : "",
    plan.familiarArtists.length > 0 && !plan.discographyIntent ? `Familiar / canonical artists you may want less of:\n${formatBulletList(plan.familiarArtists.slice(0, 5))}` : "",
    plan.clarifyingQuestions.length > 0 || discographyQuestions.length > 0
      ? `Quick questions before we lock it in:\n${formatBulletList((plan.discographyIntent ? discographyQuestions : plan.clarifyingQuestions).slice(0, 3))}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    content: [
      {
        type: "text",
        text:
          `${planSummary}` +
          `\n\nHigh-confidence picks:\n${highConfidencePreview}` +
          `\n\n${plan.discographyIntent ? `Tracklist sample (first ${previewDisplayCount}):` : "Full tracklist:"}\n${preview}` +
          `${collaborativeSections ? `\n\n${collaborativeSections}` : ""}` +
          `\n\nIf this looks good, reply create to make it in Apple Music. Otherwise reply refine <what to change> to adjust it.`,
      },
    ],
    details: {
      playlistName,
      playlistDescription: previewData.playlistDescription,
      playlistFolder: APPLE_MUSIC_FOLDER_NAME,
      trackCount,
      plan,
      selectionSeed: previewData.selectionSeed,
      proposalId: previewData.proposalId,
      proposalPath: previewData.proposalPath,
      uncoveredMajorFacets,
      songs: selectedCandidates.map((candidate) => ({
        id: candidate.song.id,
        name: candidate.song.attributes?.name,
        artistName: candidate.song.attributes?.artistName,
        albumName: candidate.song.attributes?.albumName,
        genreNames: candidate.song.attributes?.genreNames,
        url: candidate.song.attributes?.url,
        score: candidate.score,
        reasons: [...candidate.reasons, ...summarizeCandidateSignals(candidate)].slice(0, 6),
      })),
    },
  };
}

async function createCuratedPlaylist(
  pi: ExtensionAPI,
  config: Required<AppleMusicConfig>,
  params: { description: string; playlistName?: string; trackCount?: number; startPlaying?: boolean; selectionSeed?: string },
  runtime?: PlannerRuntime,
) {
  const previewData = params.selectionSeed
    ? await buildCuratedPlaylistPreview(config, params, runtime)
    : (PREVIEW_PROPOSAL_CACHE.get(buildPreviewCacheKey(params)) ?? (await buildCuratedPlaylistPreview(config, params, runtime)));
  const { plan, selectedCandidates, selected, playlistName, playlistDescription } = previewData;
  const uncoveredMajorFacets = findUncoveredMajorFacets(plan, selectedCandidates, previewData.trackCount);

  const parentFolderId = await findOrCreateLibraryPlaylistFolderId(config, APPLE_MUSIC_FOLDER_NAME);

  if (!parentFolderId && isMacOS()) {
    await ensurePlaylistFolder(pi);
  }

  const created = await createPlaylist(config, playlistName, playlistDescription, selected, parentFolderId);
  const movedToFolder = parentFolderId ? true : isMacOS() ? await movePlaylistToFolder(pi, playlistName) : false;
  if (previewData.proposalPath) {
    await updateProposalFile(previewData.proposalPath, {
      updatedAt: new Date().toISOString(),
      createdPlaylist: {
        playlistId: created.id,
        playlistName,
        movedToFolder,
        parentFolderId,
      },
    });
  }

  let playbackMessage = "";
  if (params.startPlaying && isMacOS()) {
    try {
      playbackMessage = `\n${await transport(pi, "play_playlist", { playlistName })}`;
    } catch (error) {
      playbackMessage = `\nPlaylist created, but local playback failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const preview = selected.slice(0, 10).map((song, index) => `${index + 1}. ${songLabel(song)}`).join("\n");
  const remainder = selected.length > 10 ? `\n...and ${selected.length - 10} more.` : "";
  const planSummary = [
    plan.inferredGenres.length > 0 ? `Genres: ${plan.inferredGenres.join(", ")}` : "",
    plan.facets.length > 1 ? `Facets: ${plan.facets.slice(0, 5).join(", ")}` : "",
    plan.seedArtists.length > 0 ? `Seed artists: ${plan.seedArtists.slice(0, 6).join(", ")}` : "",
    plan.discoveryIntent || plan.starterIntent ? "Mode: discovery / starter" : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text:
          `Created Apple Music playlist \"${playlistName}\" with ${selected.length} tracks.` +
          `\nPlaylist id: ${created.id}` +
          `\nFolder: ${APPLE_MUSIC_FOLDER_NAME}${movedToFolder ? "" : " (pending sync to Music.app)"}` +
          `${planSummary ? `\n${planSummary}` : ""}` +
          `${uncoveredMajorFacets.length > 0 ? `\nUncovered facets: ${uncoveredMajorFacets.join(", ")}` : ""}` +
          `\n\nTop picks:\n${preview}${remainder}${playbackMessage}`,
      },
    ],
    details: {
      playlistId: created.id,
      playlistName,
      playlistDescription,
      playlistFolder: APPLE_MUSIC_FOLDER_NAME,
      parentFolderId,
      movedToFolder,
      plan,
      selectionSeed: previewData.selectionSeed,
      proposalId: previewData.proposalId,
      proposalPath: previewData.proposalPath,
      uncoveredMajorFacets,
      songs: selectedCandidates.map((candidate) => ({
        id: candidate.song.id,
        name: candidate.song.attributes?.name,
        artistName: candidate.song.attributes?.artistName,
        albumName: candidate.song.attributes?.albumName,
        genreNames: candidate.song.attributes?.genreNames,
        url: candidate.song.attributes?.url,
        score: candidate.score,
        reasons: [...candidate.reasons, ...summarizeCandidateSignals(candidate)].slice(0, 6),
      })),
    },
  };
}

export default function appleMusicExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const config = await loadConfig(ctx.cwd);
    const playbackStatus = isMacOS() ? "local playback ready" : "local playback unavailable (macOS only)";
    const playlistStatus = config.developerToken && config.musicUserToken ? "playlist API ready" : "playlist API not configured";
    if (ctx.hasUI) {
      ctx.ui.setStatus("apple-music", `Apple Music: ${playbackStatus}; ${playlistStatus}`);
    }
  });

  pi.registerTool({
    name: "apple_music_preview_playlist",
    label: "Apple Music Playlist Preview",
    description: "Preview an Apple Music playlist proposal from a natural-language description before creating it.",
    promptSnippet: "Preview curated Apple Music playlists from natural-language mood, genre, vibe, and discovery descriptions.",
    promptGuidelines: [
      "Prefer apple_music_preview_playlist first when the user asks for a playlist, unless they explicitly ask to create it immediately.",
      "Show the proposed playlist name, genres, and tracklist so the user can review before creation.",
      "Interpret genre requests as curation requests, not literal title matching. Prefer representative artists, editorial playlist signals, and artist-led discovery.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Natural-language playlist brief, e.g. tropical house, deep house, jazzy soulful tunes" }),
      playlistName: Type.Optional(Type.String({ description: "Optional proposed playlist name" })),
      trackCount: Type.Optional(Type.Number({ minimum: 5, description: "How many tracks to include in the preview. Defaults to 25, or all tracks for discography requests." })),
      selectionSeed: Type.Optional(Type.String({ description: "Optional seed to reproduce a prior preview exactly." })),
    }),
    async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const config = await loadConfig(ctx.cwd);
      ensureApiConfig(config);
      return previewCuratedPlaylist(config, params, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel });
    },
  });

  pi.registerTool({
    name: "apple_music_create_playlist",
    label: "Apple Music Playlist",
    description: "Create an Apple Music playlist from a natural-language description using the Apple Music catalog and curated Apple Music signals.",
    promptSnippet: "Create curated Apple Music playlists from natural-language mood, genre, vibe, and discovery descriptions.",
    promptGuidelines: [
      "Use apple_music_preview_playlist first when the user asks for a playlist, unless they explicitly ask to create it immediately or confirm a reviewed proposal.",
      "Use apple_music_create_playlist when the user explicitly asks to create now, skip preview, or confirms a reviewed playlist proposal.",
      "When confirming a reviewed preview, reuse the preview selectionSeed if it is available so the created playlist matches the reviewed tracklist exactly.",
      "Interpret genre requests as curation requests, not literal title matching. Prefer representative artists, editorial playlist signals, and artist-led discovery.",
      "When the user says things like 'I want to get into k-pop' or 'where should I start with jazz', treat that as a discovery request and build an accessible starter playlist.",
      "Use apple_music_transport for local Music.app playback controls like play, pause, skip, shuffle/random, repeat, volume, or playing a specific playlist.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Natural-language playlist brief, e.g. tropical house, deep house, jazzy soulful tunes" }),
      playlistName: Type.Optional(Type.String({ description: "Optional explicit playlist name" })),
      trackCount: Type.Optional(Type.Number({ minimum: 5, description: "How many tracks to include. Defaults to 25, or all tracks for discography requests." })),
      startPlaying: Type.Optional(Type.Boolean({ description: "If true, try to start playing the playlist locally after creating it." })),
      selectionSeed: Type.Optional(Type.String({ description: "Optional seed from a reviewed preview to recreate the exact same tracklist." })),
    }),
    async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const config = await loadConfig(ctx.cwd);
      ensureApiConfig(config);
      return createCuratedPlaylist(pi, config, params, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel });
    },
  });

  pi.registerTool({
    name: "apple_music_transport",
    label: "Apple Music Control",
    description: "Control the local macOS Music app: play, pause, skip, previous, stop, shuffle/random, repeat, volume, status, or play a playlist by name.",
    promptSnippet: "Control the local macOS Apple Music app for playback and playlist transport.",
    promptGuidelines: [
      "Use this tool when the user asks to play, pause, skip, go back, randomize, shuffle, repeat, change volume, inspect current song status, or play a playlist in Apple Music.",
      "Treat 'random' as shuffle in Apple Music.",
    ],
    parameters: Type.Object({
      action: StringEnum(TRANSPORT_ACTIONS),
      playlistName: Type.Optional(Type.String({ description: "Playlist name, required for play_playlist" })),
      volume: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "Target volume for set_volume" })),
    }),
    async execute(_toolCallId: any, params: any) {
      const text = await transport(pi, params.action, { playlistName: params.playlistName, volume: params.volume });
      return {
        content: [{ type: "text", text }],
        details: {
          action: params.action,
          playlistName: params.playlistName,
          volume: params.volume,
        },
      };
    },
  });

  pi.registerCommand("apple-music-help", {
    description: "Show Apple Music extension setup and usage hints",
    handler: async (_args: any, ctx: any) => {
      const config = await loadConfig(ctx.cwd);
      const lines = [
        "Apple Music extension",
        "",
        `Playback control: ${isMacOS() ? "available on this machine" : "requires macOS"}`,
        `Playlist API configured: ${config.developerToken && config.musicUserToken ? "yes" : "no"}`,
        "",
        "Config sources:",
        "- APPLE_MUSIC_DEVELOPER_TOKEN",
        "- APPLE_MUSIC_USER_TOKEN",
        "- APPLE_MUSIC_STOREFRONT",
        "- .pi/apple-music.json",
        "- ~/.pi/agent/apple-music.json",
        "",
        "Commands:",
        "/apple-music-status",
        "/apple-music-play",
        "/apple-music-pause",
        "/apple-music-next",
        "/apple-music-prev",
        "/apple-music-shuffle on|off",
        "/apple-music-repeat off|one|all",
        "/apple-music-playlist <description>",
        "/apple-music-preview <description>",
        "/apple-music-make <description>",
        "/apple-music-proposal [last|proposal-id]",
        "/apple-music-skipped [last|proposal-id]",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  const registerTransportCommand = (
    name: string,
    description: string,
    action: (typeof TRANSPORT_ACTIONS)[number],
    parse?: (args: string) => { playlistName?: string; volume?: number },
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (args: any, ctx: any) => {
        const extra = parse?.(args) ?? {};
        const result = await transport(pi, action, extra);
        ctx.ui.notify(result, "info");
      },
    });
  };

  registerTransportCommand("apple-music-status", "Show current Apple Music playback status", "status");
  registerTransportCommand("apple-music-play", "Play Apple Music", "play");
  registerTransportCommand("apple-music-pause", "Pause Apple Music", "pause");
  registerTransportCommand("apple-music-next", "Skip to the next track", "next");
  registerTransportCommand("apple-music-prev", "Go to the previous track", "previous");

  pi.registerCommand("apple-music-shuffle", {
    description: "Set Apple Music shuffle on or off: /apple-music-shuffle on|off",
    handler: async (args: any, ctx: any) => {
      const mode = args.trim().toLowerCase();
      if (mode !== "on" && mode !== "off") {
        ctx.ui.notify("Usage: /apple-music-shuffle on|off", "warning");
        return;
      }
      const result = await transport(pi, mode === "on" ? "shuffle_on" : "shuffle_off");
      ctx.ui.notify(result, "info");
    },
  });

  pi.registerCommand("apple-music-repeat", {
    description: "Set Apple Music repeat mode: /apple-music-repeat off|one|all",
    handler: async (args: any, ctx: any) => {
      const mode = args.trim().toLowerCase();
      if (mode !== "off" && mode !== "one" && mode !== "all") {
        ctx.ui.notify("Usage: /apple-music-repeat off|one|all", "warning");
        return;
      }
      const action = mode === "off" ? "repeat_off" : mode === "one" ? "repeat_one" : "repeat_all";
      const result = await transport(pi, action);
      ctx.ui.notify(result, "info");
    },
  });

  pi.registerCommand("apple-music-playlist", {
    description: "Start collaborative Apple Music playlist planning from a text description",
    handler: async (args: any, ctx: any) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /apple-music-playlist <description>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Try again when the current turn finishes.", "warning");
        return;
      }

      try {
        ctx.ui.notify("Working on playlist preview...", "info");
        const config = await loadConfig(ctx.cwd);
        ensureApiConfig(config);
        const result = await previewCuratedPlaylist(config, { description }, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel, cwd: ctx.cwd });
        const text = result.content.find((item) => item.type === "text")?.text ?? `Previewed playlist for ${description}.`;
        appendAssistantTextMessage(pi, ctx, text);
        ctx.ui.notify(text, "info");
        ctx.ui.notify("Playlist preview ready.", "success");
      } catch (error) {
        ctx.ui.notify(`Playlist preview failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("apple-music-preview", {
    description: "Preview an Apple Music playlist from a text description",
    handler: async (args: any, ctx: any) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /apple-music-preview <description>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Try again when the current turn finishes.", "warning");
        return;
      }

      try {
        ctx.ui.notify("Working on playlist preview...", "info");
        const config = await loadConfig(ctx.cwd);
        ensureApiConfig(config);
        const result = await previewCuratedPlaylist(config, { description }, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel, cwd: ctx.cwd });
        const text = result.content.find((item) => item.type === "text")?.text ?? `Previewed playlist for ${description}.`;
        appendAssistantTextMessage(pi, ctx, text);
        ctx.ui.notify(text, "info");
        ctx.ui.notify("Playlist preview ready.", "success");
      } catch (error) {
        ctx.ui.notify(`Playlist preview failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("apple-music-make", {
    description: "Create an Apple Music playlist from a text description",
    handler: async (args: any, ctx: any) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /apple-music-make <description>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Try again when the current turn finishes.", "warning");
        return;
      }

      try {
        ctx.ui.notify("Working on playlist creation...", "info");
        const config = await loadConfig(ctx.cwd);
        ensureApiConfig(config);
        const result = await createCuratedPlaylist(pi, config, { description }, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel, cwd: ctx.cwd });
        const text = result.content.find((item) => item.type === "text")?.text ?? `Created playlist for ${description}.`;
        appendAssistantTextMessage(pi, ctx, text);
        ctx.ui.notify(text, "info");
        ctx.ui.notify("Playlist created.", "success");
      } catch (error) {
        ctx.ui.notify(`Playlist creation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("apple-music-proposal", {
    description: "Show the last saved Apple Music proposal or a specific proposal id",
    handler: async (args: any, ctx: any) => {
      const proposalRef = args.trim() || "last";
      const proposal = await loadProposal(ctx.cwd, proposalRef);
      if (!proposal) {
        ctx.ui.notify("No Apple Music proposal found.", "warning");
        return;
      }

      const summary = [
        `Proposal: ${proposal.data.playlistName ?? "Untitled"}`,
        `Path: ${proposal.path}`,
        proposal.data.counts ? `Counts: ${proposal.data.counts.selectedCount ?? 0} selected, ${proposal.data.counts.skippedCount ?? 0} skipped, ${proposal.data.counts.candidateCount ?? 0} candidates` : "",
        proposal.data.createdPlaylist?.playlistId ? `Created playlist: ${proposal.data.createdPlaylist.playlistName} (${proposal.data.createdPlaylist.playlistId})` : "",
      ]
        .filter(Boolean)
        .join("\n");

      appendAssistantTextMessage(pi, ctx, summary);
      ctx.ui.notify(summary, "info");
    },
  });

  pi.registerCommand("apple-music-skipped", {
    description: "Show skipped tracks for the last saved Apple Music proposal or a specific proposal id",
    handler: async (args: any, ctx: any) => {
      const proposalRef = args.trim() || "last";
      const proposal = await loadProposal(ctx.cwd, proposalRef);
      if (!proposal) {
        ctx.ui.notify("No Apple Music proposal found.", "warning");
        return;
      }

      const text = [
        `Skipped tracks for: ${proposal.data.playlistName ?? "Untitled"}`,
        `Path: ${proposal.path}`,
        summarizeSkippedTracks(proposal.data),
      ].join("\n\n");

      appendAssistantTextMessage(pi, ctx, text);
      ctx.ui.notify(text, "info");
    },
  });
}
