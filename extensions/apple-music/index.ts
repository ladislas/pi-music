import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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

type SearchResponse = {
  results?: {
    songs?: {
      data?: AppleMusicSong[];
    };
  };
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
  "are",
  "based",
  "for",
  "i",
  "in",
  "it",
  "me",
  "mix",
  "music",
  "of",
  "on",
  "playlist",
  "please",
  "songs",
  "some",
  "that",
  "the",
  "to",
  "track",
  "tracks",
  "tunes",
  "want",
  "with",
]);

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
    .replace(/[^a-z0-9\s,/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[\s,/-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function buildSearchQueries(description: string): string[] {
  const normalized = normalizeText(description);
  const segments = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const tokens = tokenize(description);

  const queries = [normalized, ...segments];
  if (tokens.length > 0) queries.push(tokens.slice(0, 6).join(" "));
  if (tokens.length > 2) {
    for (let i = 0; i < Math.min(tokens.length - 1, 6); i += 2) {
      const chunk = tokens.slice(i, i + 2).join(" ");
      if (chunk) queries.push(chunk);
    }
  }

  return unique(queries.filter((query) => query.length >= 3)).slice(0, 8);
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

function scoreSong(song: AppleMusicSong, description: string, queries: string[]): number {
  const haystack = normalizeText(
    [
      song.attributes?.name ?? "",
      song.attributes?.artistName ?? "",
      song.attributes?.albumName ?? "",
      ...(song.attributes?.genreNames ?? []),
    ].join(" "),
  );
  const tokens = tokenize(description);

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length > 5 ? 5 : 3;
  }
  for (const query of queries) {
    if (query.length > 4 && haystack.includes(query)) score += 10;
  }

  if ((song.attributes?.genreNames ?? []).length > 0) score += 2;
  return score;
}

async function searchSongs(config: Required<AppleMusicConfig>, description: string): Promise<AppleMusicSong[]> {
  const queries = buildSearchQueries(description);
  const allSongs: AppleMusicSong[] = [];

  for (const query of queries) {
    const path = `/v1/catalog/${encodeURIComponent(config.storefront)}/search?term=${encodeURIComponent(query)}&types=songs&limit=15`;
    const response = await appleMusicRequest<SearchResponse>(path, config);
    allSongs.push(...(response.results?.songs?.data ?? []));
  }

  const byId = new Map<string, AppleMusicSong>();
  for (const song of allSongs) {
    if (!byId.has(song.id)) byId.set(song.id, song);
  }

  return [...byId.values()].sort((a, b) => scoreSong(b, description, queries) - scoreSong(a, description, queries));
}

async function createPlaylist(
  config: Required<AppleMusicConfig>,
  name: string,
  description: string,
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
      await runAppleScript(pi, [
        'tell application "Music"',
        `set targetPlaylist to first user playlist whose name is "${name}"`,
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

export default function appleMusicExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig(ctx.cwd);
    const playbackStatus = isMacOS() ? "local playback ready" : "local playback unavailable (macOS only)";
    const playlistStatus = config.developerToken && config.musicUserToken ? "playlist API ready" : "playlist API not configured";
    if (ctx.hasUI) {
      ctx.ui.setStatus("apple-music", `Apple Music: ${playbackStatus}; ${playlistStatus}`);
    }
  });

  pi.registerTool({
    name: "apple_music_create_playlist",
    label: "Apple Music Playlist",
    description: "Create an Apple Music playlist from a natural-language description using the Apple Music catalog and add tracks to the user's library playlist.",
    promptSnippet: "Create Apple Music playlists from natural-language mood, genre, and vibe descriptions.",
    promptGuidelines: [
      "Use apple_music_create_playlist when the user asks for a playlist based on mood, genre, vibe, or a textual description.",
      "Use apple_music_transport for local Music.app playback controls like play, pause, skip, shuffle/random, repeat, volume, or playing a specific playlist.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Natural-language playlist brief, e.g. tropical house, deep house, jazzy soulful tunes" }),
      playlistName: Type.Optional(Type.String({ description: "Optional explicit playlist name" })),
      trackCount: Type.Optional(Type.Number({ minimum: 5, maximum: 100, description: "How many tracks to include. Defaults to 25." })),
      startPlaying: Type.Optional(Type.Boolean({ description: "If true, try to start playing the playlist locally after creating it." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      ensureApiConfig(config);

      const candidates = await searchSongs(config, params.description);
      if (candidates.length === 0) {
        throw new Error(`No Apple Music songs matched: ${params.description}`);
      }

      const trackCount = clamp(Math.round(params.trackCount ?? 25), 5, 100);
      const selected = candidates.slice(0, trackCount);
      const playlistName = (params.playlistName?.trim() || derivePlaylistName(params.description)).slice(0, 100);
      const playlistDescription = `Generated by pi from: ${params.description}`;
      const created = await createPlaylist(config, playlistName, playlistDescription, selected);

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

      return {
        content: [
          {
            type: "text",
            text:
              `Created Apple Music playlist \"${playlistName}\" with ${selected.length} tracks.` +
              `\nPlaylist id: ${created.id}` +
              `\n\nTop picks:\n${preview}${remainder}${playbackMessage}`,
          },
        ],
        details: {
          playlistId: created.id,
          playlistName,
          playlistDescription,
          songs: selected.map((song) => ({
            id: song.id,
            name: song.attributes?.name,
            artistName: song.attributes?.artistName,
            albumName: song.attributes?.albumName,
            genreNames: song.attributes?.genreNames,
            url: song.attributes?.url,
          })),
        },
      };
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
    async execute(_toolCallId, params) {
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
    handler: async (_args, ctx) => {
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
      handler: async (args, ctx) => {
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
    handler: async (args, ctx) => {
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
    handler: async (args, ctx) => {
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

  pi.registerCommand("apple-music-make", {
    description: "Create an Apple Music playlist from a text description",
    handler: async (args, ctx) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /apple-music-make <description>", "warning");
        return;
      }

      const config = await loadConfig(ctx.cwd);
      ensureApiConfig(config);
      const candidates = await searchSongs(config, description);
      const selected = candidates.slice(0, 25);
      if (selected.length === 0) {
        throw new Error(`No Apple Music songs matched: ${description}`);
      }

      const playlistName = derivePlaylistName(description);
      const created = await createPlaylist(config, playlistName, `Generated by pi from: ${description}`, selected);
      ctx.ui.notify(`Created playlist \"${playlistName}\" (${created.id}) with ${selected.length} tracks.`, "info");
    },
  });
}
