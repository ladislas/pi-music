import type { CandidateSong, PlaylistPlan } from "./types.js";
import { clamp, normalizeText } from "./utils.js";

export function buildSongHaystack(song: CandidateSong["song"]): string {
  return normalizeText(
    [
      song.attributes?.name ?? "",
      song.attributes?.artistName ?? "",
      song.attributes?.albumName ?? "",
      ...(song.attributes?.genreNames ?? []),
    ].join(" "),
  );
}

export function isGenericArtistName(value: string): boolean {
  const normalized = normalizeText(value);
  return /(house music dj|various artists|workout|relax|sleep|study|beats|background music|meditation)/.test(normalized);
}

export function annotateFacetMatches(candidate: CandidateSong, plan: PlaylistPlan): void {
  const haystack = buildSongHaystack(candidate.song);
  for (const facet of plan.facets) {
    const normalizedFacet = normalizeText(facet);
    if (normalizedFacet && haystack.includes(normalizedFacet)) {
      candidate.facetMatches.add(facet);
    }
  }
}

export function scoreCandidate(songCandidate: CandidateSong, plan: PlaylistPlan): number {
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

export function summarizeCandidateSignals(candidate: CandidateSong): string[] {
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

export function canonicalizeTrackTitle(title: string): string {
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

export function songArtistIncludesTarget(songArtistName: string, targetArtistName: string): boolean {
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

export function findUncoveredMajorFacets(plan: PlaylistPlan, selected: CandidateSong[], trackCount: number): string[] {
  const covered = new Set(selected.flatMap((candidate) => [...candidate.facetMatches]));
  return buildMajorFacets(plan, trackCount).filter((facet) => !covered.has(facet));
}

export function buildDiscographySelection(
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

export function selectPlaylistSongs(candidates: CandidateSong[], trackCount: number, seedKey: string, plan: PlaylistPlan): CandidateSong[] {
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

export { classifyReleaseType };
