import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { ensureApiConfig, loadConfig, buildStoredPlaylistDescription, writeProposalFile, updateProposalFile, loadProposal, summarizeSkippedTracks, candidateToSerializable } from "./config.js";
import type {
  AppleMusicAlbum,
  AppleMusicArtist,
  AppleMusicConfig,
  AppleMusicPlaylist,
  AppleMusicSong,
  CandidateSong,
  CreatePlaylistResponse,
  LibraryPlaylistFolder,
  LibraryPlaylistFoldersResponse,
  PlannerRuntime,
  PlaylistPlan,
  SearchResponse,
  TracksResponse,
} from "./types.js";
import { buildPlaylistPlan, detectDiscographyIntent } from "./planner.js";
import {
  annotateFacetMatches,
  buildDiscographySelection,
  buildSongHaystack,
  canonicalTrackSignature,
  classifyReleaseType,
  findUncoveredMajorFacets,
  isGenericArtistName,
  scoreCandidate,
  selectPlaylistSongs,
  songArtistIncludesTarget,
  summarizeCandidateSignals,
} from "./selection.js";
import {
  appendAssistantTextMessage,
  clamp,
  derivePlaylistName,
  formatBulletList,
  isMacOS,
  normalizeText,
  songLabel,
  unique,
} from "./utils.js";

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
