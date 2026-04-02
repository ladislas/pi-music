import test from "node:test";
import assert from "node:assert/strict";

import { buildDiscographySelection, songArtistIncludesTarget } from "../extensions/apple-music/discography-logic.js";

function candidate(id, name, artistName, releaseName, releaseType) {
  return {
    song: { id, type: "songs", attributes: { name, artistName, albumName: releaseName } },
    directSongHits: 0,
    artistTopSongHits: 0,
    albumTrackHits: 0,
    playlistTrackHits: 0,
    editorialAlbumHits: 0,
    editorialPlaylistHits: 0,
    seedArtistHits: 0,
    relatedArtistHits: 0,
    queryMatches: new Set(),
    genresMatched: new Set(),
    facetMatches: new Set(),
    reasons: new Set(),
    sourceReleaseName: releaseName,
    sourceReleaseType: releaseType,
    score: 0,
  };
}

const basePlan = {
  originalDescription: "all songs by SYML, complete discography",
  normalizedDescription: "all songs by syml complete discography",
  inferredGenres: [],
  matchedSeedEntries: [],
  facets: [],
  queries: [],
  seedArtists: [],
  relatedArtists: [],
  avoidTerms: [],
  optionalDirections: [],
  clarifyingQuestions: [],
  familiarArtists: [],
  discographyIntent: true,
  strictArtistOnly: false,
  targetArtist: "SYML",
  discoveryIntent: false,
  starterIntent: false,
  broadRequest: false,
  moods: [],
  notes: [],
};

test("songArtistIncludesTarget matches collaborations listed in artist field", () => {
  assert.equal(songArtistIncludesTarget("SYML, sagun", "SYML"), true);
  assert.equal(songArtistIncludesTarget("Lana Del Rey", "SYML"), false);
});

test("buildDiscographySelection keeps album tracks and skips duplicate singles by default", () => {
  const albumTrack = candidate("1", "Carry No Thing", "SYML", "Nobody Lives Here", "album");
  const duplicateSingle = candidate("2", "Carry No Thing", "SYML", "Carry No Thing - Single", "single");
  const altSingle = candidate("3", "Carry No Thing (Live)", "SYML", "Carry No Thing (Live) - Single", "single");

  const { selectedCandidates, skippedCandidates } = buildDiscographySelection([albumTrack, duplicateSingle, altSingle], basePlan, (item) => item.song.attributes.name.toLowerCase());
  assert.deepEqual(selectedCandidates.map((item) => item.song.id), ["1"]);
  assert.equal(skippedCandidates.length, 2);
});

test("buildDiscographySelection keeps alternate versions when explicitly requested", () => {
  const albumTrack = candidate("1", "Carry No Thing", "SYML", "Nobody Lives Here", "album");
  const altSingle = candidate("3", "Carry No Thing (Live)", "SYML", "Carry No Thing (Live) - Single", "single");
  const plan = { ...basePlan, normalizedDescription: "all songs by syml complete discography live acoustic alternate remix" };

  const { selectedCandidates } = buildDiscographySelection([albumTrack, altSingle], plan, (item) => item.song.attributes.name.toLowerCase());
  assert.deepEqual(selectedCandidates.map((item) => item.song.id), ["1", "3"]);
});
