import type {
  AppleMusicAlbum,
  AppleMusicConfig,
  AppleMusicPlaylist,
  AppleMusicSong,
  CandidateSong,
  CreatePlaylistResponse,
  LibraryPlaylistFolder,
  LibraryPlaylistFoldersResponse,
  SearchResponse,
  TracksResponse,
} from "./types.js";
import { normalizeText } from "./utils.js";

const PLAYLIST_FOLDER_ID_CACHE = new Map<string, string>();

export async function appleMusicRequest<T>(path: string, config: Required<AppleMusicConfig>, init?: RequestInit): Promise<T> {
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

export async function searchCatalog(
  config: Required<AppleMusicConfig>,
  term: string,
  types: Array<"songs" | "artists" | "albums" | "playlists">,
  limit = 10,
): Promise<SearchResponse> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/search?term=${encodeURIComponent(term)}&types=${types.join(",")}&limit=${limit}`;
  return appleMusicRequest<SearchResponse>(path, config);
}

export async function fetchArtistTopSongs(config: Required<AppleMusicConfig>, artistId: string, limit = 5): Promise<AppleMusicSong[]> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/artists/${encodeURIComponent(artistId)}/view/top-songs?limit=${limit}`;
  const response = await appleMusicRequest<TracksResponse>(path, config);
  return (response.data ?? []).filter((song) => song.type === "songs");
}

export async function fetchArtistAlbums(config: Required<AppleMusicConfig>, artistId: string, limit = 100): Promise<AppleMusicAlbum[]> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/artists/${encodeURIComponent(artistId)}/albums?limit=${limit}`;
  const response = await appleMusicRequest<{ data?: AppleMusicAlbum[] }>(path, config);
  return response.data ?? [];
}

export async function fetchAlbumTracks(config: Required<AppleMusicConfig>, albumId: string, limit = 6): Promise<AppleMusicSong[]> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/albums/${encodeURIComponent(albumId)}/tracks?limit=${limit}`;
  const response = await appleMusicRequest<TracksResponse>(path, config);
  return (response.data ?? []).filter((song) => song.type === "songs");
}

export async function fetchPlaylistTracks(config: Required<AppleMusicConfig>, playlistId: string, limit = 12): Promise<AppleMusicSong[]> {
  const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}`;
  const response = await appleMusicRequest<TracksResponse>(path, config);
  return (response.data ?? []).filter((song) => song.type === "songs");
}

export function trackCandidate(map: Map<string, CandidateSong>, song: AppleMusicSong): CandidateSong {
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

export function isEditorialPlaylist(playlist: AppleMusicPlaylist): boolean {
  const curator = normalizeText(playlist.attributes?.curatorName ?? "");
  return curator.includes("apple music") || Boolean(playlist.attributes?.editorialNotes?.standard || playlist.attributes?.description?.standard);
}

export function isEditorialAlbum(album: AppleMusicAlbum): boolean {
  return Boolean(album.attributes?.editorialNotes?.standard || album.attributes?.editorialNotes?.short);
}

export async function fetchLibraryPlaylistFolders(config: Required<AppleMusicConfig>, limit = 100): Promise<LibraryPlaylistFolder[]> {
  const response = await appleMusicRequest<LibraryPlaylistFoldersResponse>(`/v1/me/library/playlist-folders?limit=${limit}`, config);
  return response.data ?? [];
}

export async function createLibraryPlaylistFolder(config: Required<AppleMusicConfig>, name: string): Promise<LibraryPlaylistFolder> {
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

export async function findOrCreateLibraryPlaylistFolderId(config: Required<AppleMusicConfig>, name: string): Promise<string | undefined> {
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

export async function createPlaylist(
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
