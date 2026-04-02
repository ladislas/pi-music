import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { isMacOS } from "./utils.js";

export function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAppleScript(pi: ExtensionAPI, lines: string[]): Promise<string> {
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

export async function ensurePlaylistFolder(pi: ExtensionAPI, folderName: string): Promise<void> {
  const name = esc(folderName);
  await runAppleScript(pi, [
    'tell application "Music"',
    `if not (exists folder playlist "${name}") then`,
    `make new folder playlist with properties {name:"${name}"}`,
    "end if",
    'end tell',
  ]);
}

export async function movePlaylistToFolder(
  pi: ExtensionAPI,
  playlistName: string,
  folderName: string,
  options: { attempts: number; delayMs: number; initialDelayMs: number },
): Promise<boolean> {
  const playlist = esc(playlistName);
  const folder = esc(folderName);
  const attempts = Math.max(1, options.attempts);
  const delayMs = Math.max(0, options.delayMs);
  const initialDelayMs = Math.max(0, options.initialDelayMs);

  if (initialDelayMs > 0) {
    await delay(initialDelayMs);
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await runAppleScript(pi, [
        'tell application "Music"',
        `if not (exists folder playlist "${folder}") then`,
        `make new folder playlist with properties {name:"${folder}"}`,
        "end if",
        `if exists user playlist "${playlist}" then`,
        `set targetPlaylist to first user playlist whose name is "${playlist}"`,
        `move targetPlaylist to folder playlist "${folder}"`,
        "return \"ok\"",
        "end if",
        'end tell',
      ]);
      return true;
    } catch {
      if (attempt < attempts - 1 && delayMs > 0) {
        await delay(delayMs);
      }
    }
  }

  return false;
}

export async function transport(
  pi: ExtensionAPI,
  folderName: string,
  action:
    | "play"
    | "pause"
    | "playpause"
    | "next"
    | "previous"
    | "stop"
    | "shuffle_on"
    | "shuffle_off"
    | "shuffle_toggle"
    | "repeat_off"
    | "repeat_one"
    | "repeat_all"
    | "set_volume"
    | "play_playlist"
    | "status",
  options?: { playlistName?: string; volume?: number },
): Promise<string> {
  switch (action) {
    case "play":
      await runAppleScript(pi, ['tell application "Music" to play']);
      return "Playing Apple Music.";
    case "pause":
      await runAppleScript(pi, ['tell application "Music" to pause']);
      return "Paused Apple Music.";
    case "playpause":
      await runAppleScript(pi, ['tell application "Music" to playpause']);
      return "Toggled play/pause.";
    case "next":
      await runAppleScript(pi, ['tell application "Music" to next track']);
      return "Skipped to the next track.";
    case "previous":
      await runAppleScript(pi, ['tell application "Music" to previous track']);
      return "Went to the previous track.";
    case "stop":
      await runAppleScript(pi, ['tell application "Music" to stop']);
      return "Stopped Apple Music.";
    case "shuffle_on":
      await runAppleScript(pi, ['tell application "Music" to set shuffle enabled to true']);
      return "Shuffle enabled.";
    case "shuffle_off":
      await runAppleScript(pi, ['tell application "Music" to set shuffle enabled to false']);
      return "Shuffle disabled.";
    case "shuffle_toggle": {
      const output = await runAppleScript(pi, [
        'tell application "Music"',
        'set shuffle enabled to not shuffle enabled',
        'return shuffle enabled as text',
        'end tell',
      ]);
      return output === "true" ? "Shuffle enabled." : "Shuffle disabled.";
    }
    case "repeat_off":
      await runAppleScript(pi, ['tell application "Music" to set song repeat to off']);
      return "Repeat off.";
    case "repeat_one":
      await runAppleScript(pi, ['tell application "Music" to set song repeat to one']);
      return "Repeat one enabled.";
    case "repeat_all":
      await runAppleScript(pi, ['tell application "Music" to set song repeat to all']);
      return "Repeat all enabled.";
    case "set_volume": {
      if (typeof options?.volume !== "number") throw new Error("volume is required for set_volume.");
      const volume = Math.max(0, Math.min(100, Math.round(options.volume)));
      await runAppleScript(pi, [`tell application "Music" to set sound volume to ${volume}`]);
      return `Set Apple Music volume to ${volume}.`;
    }
    case "play_playlist": {
      if (!options?.playlistName) throw new Error("playlistName is required for play_playlist.");
      const name = esc(options.playlistName);
      const folder = esc(folderName);
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
