import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  buildStoredPlaylistDescription,
  candidateToSerializable,
  updateProposalFile,
  writeProposalFile,
} from "./config.js";
import {
  APPLE_MUSIC_FOLDER_NAME,
  APPLE_MUSIC_MOVE_ATTEMPTS,
  APPLE_MUSIC_MOVE_INITIAL_DELAY_MS,
  APPLE_MUSIC_MOVE_RETRY_DELAY_MS,
} from "./constants.js";
import type { AppleMusicConfig, CandidateSong, PlannerRuntime, PlaylistPlan } from "./types.js";
import {
  createPlaylist,
  fetchAlbumTracks,
  fetchArtistAlbums,
  fetchArtistTopSongs,
  fetchPlaylistTracks,
  findOrCreateLibraryPlaylistFolderId,
  isEditorialAlbum,
  isEditorialPlaylist,
  searchCatalog,
  trackCandidate,
} from "./catalog.js";
import { buildPlaylistPlan } from "./planner.js";
import {
  annotateFacetMatches,
  buildDiscographySelectionForPlan,
  buildSongHaystack,
  classifyReleaseType,
  findUncoveredMajorFacets,
  scoreCandidate,
  selectPlaylistSongs,
  songArtistIncludesTarget,
  summarizeCandidateSignals,
} from "./selection.js";
import { ensurePlaylistFolder, movePlaylistToFolder, transport } from "./transport.js";
import { derivePlaylistName, formatBulletList, isMacOS, normalizeText, songLabel, unique } from "./utils.js";

const PREVIEW_PROPOSAL_CACHE = new Map<string, Awaited<ReturnType<typeof buildCuratedPlaylistPreview>>>();

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
  const discographySelection = plan.discographyIntent ? buildDiscographySelectionForPlan(candidates, plan) : undefined;
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

export async function previewCuratedPlaylist(
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

export async function createCuratedPlaylist(
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
    await ensurePlaylistFolder(pi, APPLE_MUSIC_FOLDER_NAME);
  }

  const created = await createPlaylist(config, playlistName, playlistDescription, selected, parentFolderId);
  const movedToFolder = parentFolderId
    ? true
    : isMacOS()
      ? await movePlaylistToFolder(pi, playlistName, APPLE_MUSIC_FOLDER_NAME, {
          attempts: APPLE_MUSIC_MOVE_ATTEMPTS,
          delayMs: APPLE_MUSIC_MOVE_RETRY_DELAY_MS,
          initialDelayMs: APPLE_MUSIC_MOVE_INITIAL_DELAY_MS,
        })
      : false;
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
      playbackMessage = `\n${await transport(pi, APPLE_MUSIC_FOLDER_NAME, "play_playlist", { playlistName })}`;
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
