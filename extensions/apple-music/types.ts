import type { SeedGenreEntry } from "./genre-seeds.js";

export type AppleMusicConfig = {
  developerToken?: string;
  musicUserToken?: string;
  storefront?: string;
  plannerModel?: string;
};

export type AppleMusicSong = {
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

export type AppleMusicArtist = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    genreNames?: string[];
    editorialNotes?: { standard?: string; short?: string };
  };
};

export type AppleMusicAlbum = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    genreNames?: string[];
    editorialNotes?: { standard?: string; short?: string };
  };
};

export type AppleMusicPlaylist = {
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

export type SearchResponse = {
  results?: {
    songs?: { data?: AppleMusicSong[] };
    artists?: { data?: AppleMusicArtist[] };
    albums?: { data?: AppleMusicAlbum[] };
    playlists?: { data?: AppleMusicPlaylist[] };
  };
};

export type TracksResponse = {
  data?: AppleMusicSong[];
};

export type CreatePlaylistResponse = {
  data?: Array<{
    id: string;
    type: string;
    attributes?: {
      name?: string;
      description?: { standard?: string };
    };
  }>;
};

export type LibraryPlaylistFolder = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    description?: { standard?: string; short?: string };
  };
};

export type LibraryPlaylistFoldersResponse = {
  data?: LibraryPlaylistFolder[];
  next?: string;
};

export type PlaylistPlannerSuggestion = {
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

export type PlaylistPlan = {
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

export type CandidateSong = {
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

export type PlannerRuntime = {
  model?: any;
  modelRegistry?: any;
  plannerModel?: string;
  cwd?: string;
};
