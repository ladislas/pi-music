import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { GENRE_SEED_MAP, type SeedGenreEntry } from "./genre-seeds.js";

type AppleMusicConfig = {
  developerToken?: string;
  musicUserToken?: string;
  storefront?: string;
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

type PlaylistPlan = {
  originalDescription: string;
  normalizedDescription: string;
  inferredGenres: string[];
  matchedSeedEntries: SeedGenreEntry[];
  queries: string[];
  seedArtists: string[];
  relatedArtists: string[];
  avoidTerms: string[];
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
  editorialPlaylistHits: number;
  seedArtistHits: number;
  relatedArtistHits: number;
  queryMatches: Set<string>;
  genresMatched: Set<string>;
  reasons: Set<string>;
  score: number;
};

const APPLE_MUSIC_FOLDER_NAME = "piMusic";
const APPLE_MUSIC_MOVE_INITIAL_DELAY_MS = 10_000;
const APPLE_MUSIC_MOVE_RETRY_DELAY_MS = 2_500;
const APPLE_MUSIC_MOVE_ATTEMPTS = 4;
const PREVIEW_PROPOSAL_CACHE = new Map<string, Awaited<ReturnType<typeof buildCuratedPlaylistPreview>>>();

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

function songLabel(song: AppleMusicSong): string {
  const name = song.attributes?.name ?? "Unknown title";
  const artist = song.attributes?.artistName ?? "Unknown artist";
  return `${name} — ${artist}`;
}

function splitPromptSegments(description: string): string[] {
  return unique(
    description
      .split(/[,;]+|\band\b/gi)
      .map((part) => part.trim())
      .filter((part) => normalizeText(part).length >= 3),
  );
}

function hasPattern(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function buildPlaylistPlan(description: string): PlaylistPlan {
  const normalizedDescription = normalizeText(description);
  const matchedEntries: SeedGenreEntry[] = [];

  for (const [genreKey, entry] of Object.entries(GENRE_SEED_MAP)) {
    const phrases = unique([genreKey, entry.canonicalGenre, ...(entry.aliases ?? [])].map(normalizeText));
    if (phrases.some((phrase) => phrase && normalizedDescription.includes(phrase))) {
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
    ].map(normalizeText),
  ).filter(Boolean);

  const queries = unique(
    [
      normalizedDescription,
      ...splitPromptSegments(description),
      ...inferredGenres,
      ...matchedEntries.flatMap((entry) => entry.aliases.slice(0, 2)),
      ...moods.slice(0, 3).map((mood) => `${mood} ${inferredGenres[0] ?? "music"}`),
    ]
      .map((query) => normalizeText(query))
      .filter((query) => query.length >= 3),
  ).slice(0, 8);

  const discoveryIntent = hasPattern(DISCOVERY_PATTERNS, description);
  const starterIntent = discoveryIntent || hasPattern(STARTER_PATTERNS, description);
  const broadRequest = inferredGenres.length >= 3 || (inferredGenres.length === 0 && tokenize(description).length >= 5);
  const notes = unique(matchedEntries.map((entry) => entry.notes).filter((note): note is string => Boolean(note))).slice(0, 3);

  return {
    originalDescription: description,
    normalizedDescription,
    inferredGenres,
    matchedSeedEntries: matchedEntries,
    queries,
    seedArtists,
    relatedArtists,
    avoidTerms,
    discoveryIntent,
    starterIntent,
    broadRequest,
    moods,
    notes,
  };
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
    editorialPlaylistHits: 0,
    seedArtistHits: 0,
    relatedArtistHits: 0,
    queryMatches: new Set<string>(),
    genresMatched: new Set<string>(),
    reasons: new Set<string>(),
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
  score += songCandidate.editorialPlaylistHits * 10;
  score += songCandidate.seedArtistHits * 36;
  score += songCandidate.relatedArtistHits * 18;
  score += songCandidate.queryMatches.size * 4;
  score += songCandidate.genresMatched.size * 8;

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

  return score;
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
  const title = canonicalizeTrackTitle(candidate.song.attributes?.name ?? "");
  const artist = normalizeText(candidate.song.attributes?.artistName ?? "");
  return `${artist}::${title}`;
}

function canSelectCandidate(
  candidate: CandidateSong,
  selected: CandidateSong[],
  artistCounts: Map<string, number>,
  albumCounts: Map<string, number>,
  maxPerArtist: number,
  maxPerAlbum: number,
  enforceSequentialGenreDiversity: boolean,
): boolean {
  const artist = candidate.song.attributes?.artistName ?? "Unknown artist";
  const album = candidate.song.attributes?.albumName ?? "Unknown album";
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

function selectPlaylistSongs(candidates: CandidateSong[], trackCount: number, seedKey: string): CandidateSong[] {
  const maxPerArtist = trackCount <= 15 ? 1 : trackCount >= 30 ? 3 : 2;
  const maxPerAlbum = trackCount <= 20 ? 1 : 2;
  const rng = createSeededRng(hashSeed(seedKey));
  const ranked = shuffleWithinScoreBands(candidates, rng);
  const initialPoolSize = clamp(Math.max(trackCount * 3, 30), trackCount, ranked.length);
  const targetSelectionCount = clamp(Math.max(trackCount + 15, Math.ceil(trackCount * 1.8)), trackCount, ranked.length);
  const preliminary: CandidateSong[] = [];
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const available = [...ranked.slice(0, initialPoolSize)];
  const fallback = [...ranked.slice(initialPoolSize)];

  const takePreliminaryCandidate = (candidate: CandidateSong) => {
    preliminary.push(candidate);
    const artist = candidate.song.attributes?.artistName ?? "Unknown artist";
    const album = candidate.song.attributes?.albumName ?? "Unknown album";
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    albumCounts.set(album, (albumCounts.get(album) ?? 0) + 1);
  };

  while (preliminary.length < targetSelectionCount && (available.length > 0 || fallback.length > 0)) {
    if (available.length === 0 && fallback.length > 0) {
      available.push(...fallback.splice(0, Math.max(5, targetSelectionCount - preliminary.length)));
    }

    let eligible = available.filter((candidate) =>
      canSelectCandidate(candidate, preliminary, artistCounts, albumCounts, maxPerArtist, maxPerAlbum, true),
    );
    if (eligible.length === 0) {
      eligible = available.filter((candidate) =>
        canSelectCandidate(candidate, preliminary, artistCounts, albumCounts, maxPerArtist, maxPerAlbum, false),
      );
    }
    if (eligible.length === 0) {
      eligible = available.filter((candidate) => {
        const artist = candidate.song.attributes?.artistName ?? "Unknown artist";
        return (artistCounts.get(artist) ?? 0) < maxPerArtist;
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
  const finalizeFrom = [...preliminary, ...ranked.filter((candidate) => !preliminary.some((picked) => picked.song.id === candidate.song.id))];

  for (const candidate of finalizeFrom) {
    const signature = canonicalTrackSignature(candidate);
    if (seenSignatures.has(signature)) continue;
    finalized.push(candidate);
    seenSignatures.add(signature);
    if (finalized.length >= trackCount) break;
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

async function collectAlbumCandidates(
  config: Required<AppleMusicConfig>,
  plan: PlaylistPlan,
  candidates: Map<string, CandidateSong>,
): Promise<void> {
  for (const query of plan.queries.slice(0, 4)) {
    const response = await searchCatalog(config, query, ["albums"], 3);
    for (const album of response.results?.albums?.data ?? []) {
      if (!album.id) continue;
      const tracks = await fetchAlbumTracks(config, album.id, 5);
      for (const song of tracks) {
        const candidate = trackCandidate(candidates, song);
        candidate.albumTrackHits += 1;
        candidate.queryMatches.add(query);
        candidate.reasons.add(`album signal: ${album.attributes?.name ?? query}`);
      }
    }
  }
}

async function collectPlaylistCandidates(
  config: Required<AppleMusicConfig>,
  plan: PlaylistPlan,
  candidates: Map<string, CandidateSong>,
): Promise<void> {
  for (const query of plan.queries.slice(0, 4)) {
    const response = await searchCatalog(config, query, ["playlists"], 3);
    for (const playlist of response.results?.playlists?.data ?? []) {
      if (!playlist.id) continue;
      const tracks = await fetchPlaylistTracks(config, playlist.id, plan.discoveryIntent || plan.starterIntent ? 14 : 10);
      const editorial = isEditorialPlaylist(playlist);
      for (const song of tracks) {
        const candidate = trackCandidate(candidates, song);
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

async function curateSongs(config: Required<AppleMusicConfig>, description: string): Promise<{ plan: PlaylistPlan; candidates: CandidateSong[] }> {
  const plan = buildPlaylistPlan(description);
  const candidates = new Map<string, CandidateSong>();

  await collectDirectSongCandidates(config, plan, candidates);
  await collectArtistCandidates(config, plan, candidates);
  await collectAlbumCandidates(config, plan, candidates);
  await collectPlaylistCandidates(config, plan, candidates);

  const ranked = [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, plan),
    }))
    .sort((a, b) => b.score - a.score);

  return { plan, candidates: ranked };
}

async function createPlaylist(
  config: Required<AppleMusicConfig>,
  name: string,
  _description: string,
  songs: AppleMusicSong[],
): Promise<{ id: string; songs: AppleMusicSong[] }> {
  const createResponse = await appleMusicRequest<CreatePlaylistResponse>("/v1/me/library/playlists", config, {
    method: "POST",
    body: JSON.stringify({
      attributes: {
        name,
      },
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
) {
  const { plan, candidates } = await curateSongs(config, params.description);
  if (candidates.length === 0) {
    throw new Error(`No Apple Music songs matched: ${params.description}`);
  }

  const trackCount = clamp(Math.round(params.trackCount ?? 25), 5, 100);
  const selectionSeed = params.selectionSeed ?? `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  const selectionSeedKey = `${params.description}::${params.playlistName ?? ""}::${trackCount}::${selectionSeed}`;
  const selectedCandidates = selectPlaylistSongs(candidates, trackCount, selectionSeedKey);
  if (selectedCandidates.length === 0) {
    throw new Error(`No Apple Music songs matched: ${params.description}`);
  }

  const selected = selectedCandidates.map((candidate) => candidate.song);
  const playlistName = (params.playlistName?.trim() || derivePlaylistName(params.description)).slice(0, 100);
  const playlistDescription = `Generated by pi from: ${params.description}`;

  return {
    plan,
    trackCount,
    selectedCandidates,
    selected,
    playlistName,
    playlistDescription,
    selectionSeed,
  };
}

async function previewCuratedPlaylist(
  config: Required<AppleMusicConfig>,
  params: { description: string; playlistName?: string; trackCount?: number; selectionSeed?: string },
) {
  const previewData = await buildCuratedPlaylistPreview(config, params);
  PREVIEW_PROPOSAL_CACHE.set(buildPreviewCacheKey(params), previewData);
  const { plan, trackCount, selected, selectedCandidates, playlistName } = previewData;
  const preview = selected.map((song, index) => `${index + 1}. ${songLabel(song)}`).join("\n");
  const planSummary = [
    `Proposed playlist: \"${playlistName}\"`,
    `Tracks: ${trackCount}`,
    plan.inferredGenres.length > 0 ? `Genres: ${plan.inferredGenres.join(", ")}` : "",
    plan.seedArtists.length > 0 ? `Seed artists: ${plan.seedArtists.slice(0, 6).join(", ")}` : "",
    plan.discoveryIntent || plan.starterIntent ? "Mode: discovery / starter" : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text: `${planSummary}\n\nTracklist:\n${preview}\n\nReply with create/confirm to make it in Apple Music, or ask to regenerate/change the name/count.`,
      },
    ],
    details: {
      playlistName,
      playlistDescription: previewData.playlistDescription,
      playlistFolder: APPLE_MUSIC_FOLDER_NAME,
      trackCount,
      plan,
      selectionSeed: previewData.selectionSeed,
      songs: selectedCandidates.map((candidate) => ({
        id: candidate.song.id,
        name: candidate.song.attributes?.name,
        artistName: candidate.song.attributes?.artistName,
        albumName: candidate.song.attributes?.albumName,
        genreNames: candidate.song.attributes?.genreNames,
        url: candidate.song.attributes?.url,
        score: candidate.score,
        reasons: [...candidate.reasons].slice(0, 4),
      })),
    },
  };
}

async function createCuratedPlaylist(
  pi: ExtensionAPI,
  config: Required<AppleMusicConfig>,
  params: { description: string; playlistName?: string; trackCount?: number; startPlaying?: boolean; selectionSeed?: string },
) {
  const previewData = params.selectionSeed
    ? await buildCuratedPlaylistPreview(config, params)
    : (PREVIEW_PROPOSAL_CACHE.get(buildPreviewCacheKey(params)) ?? (await buildCuratedPlaylistPreview(config, params)));
  const { plan, selectedCandidates, selected, playlistName, playlistDescription } = previewData;

  if (isMacOS()) {
    await ensurePlaylistFolder(pi);
  }

  const created = await createPlaylist(config, playlistName, playlistDescription, selected);
  const movedToFolder = isMacOS() ? await movePlaylistToFolder(pi, playlistName) : false;

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
          `\n\nTop picks:\n${preview}${remainder}${playbackMessage}`,
      },
    ],
    details: {
      playlistId: created.id,
      playlistName,
      playlistDescription,
      playlistFolder: APPLE_MUSIC_FOLDER_NAME,
      movedToFolder,
      plan,
      selectionSeed: previewData.selectionSeed,
      songs: selectedCandidates.map((candidate) => ({
        id: candidate.song.id,
        name: candidate.song.attributes?.name,
        artistName: candidate.song.attributes?.artistName,
        albumName: candidate.song.attributes?.albumName,
        genreNames: candidate.song.attributes?.genreNames,
        url: candidate.song.attributes?.url,
        score: candidate.score,
        reasons: [...candidate.reasons].slice(0, 4),
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
      trackCount: Type.Optional(Type.Number({ minimum: 5, maximum: 100, description: "How many tracks to include in the preview. Defaults to 25." })),
      selectionSeed: Type.Optional(Type.String({ description: "Optional seed to reproduce a prior preview exactly." })),
    }),
    async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const config = await loadConfig(ctx.cwd);
      ensureApiConfig(config);
      return previewCuratedPlaylist(config, params);
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
      trackCount: Type.Optional(Type.Number({ minimum: 5, maximum: 100, description: "How many tracks to include. Defaults to 25." })),
      startPlaying: Type.Optional(Type.Boolean({ description: "If true, try to start playing the playlist locally after creating it." })),
      selectionSeed: Type.Optional(Type.String({ description: "Optional seed from a reviewed preview to recreate the exact same tracklist." })),
    }),
    async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const config = await loadConfig(ctx.cwd);
      ensureApiConfig(config);
      return createCuratedPlaylist(pi, config, params);
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
        "/apple-music-preview <description>",
        "/apple-music-make <description>",
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

  pi.registerCommand("apple-music-preview", {
    description: "Preview an Apple Music playlist from a text description",
    handler: async (args: any, ctx: any) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /apple-music-preview <description>", "warning");
        return;
      }

      const config = await loadConfig(ctx.cwd);
      ensureApiConfig(config);
      const result = await previewCuratedPlaylist(config, { description, trackCount: 25 });
      const text = result.content.find((item) => item.type === "text")?.text ?? `Previewed playlist for ${description}.`;
      ctx.ui.notify(text, "info");
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

      const config = await loadConfig(ctx.cwd);
      ensureApiConfig(config);
      const result = await createCuratedPlaylist(pi, config, { description, trackCount: 25 });
      const text = result.content.find((item) => item.type === "text")?.text ?? `Created playlist for ${description}.`;
      ctx.ui.notify(text, "info");
    },
  });
}
