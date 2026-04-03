import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./config.js";
import { registerAppleMusicPlayback } from "./playback-registration.js";
import { registerAppleMusicPlaylists } from "./playlist-registration.js";
import { isMacOS } from "./utils.js";

export default function appleMusicExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const config = await loadConfig(ctx.cwd);
    const playbackStatus = isMacOS() ? "local playback ready" : "local playback unavailable (macOS only)";
    const playlistStatus = config.developerToken && config.musicUserToken ? "playlist API ready" : "playlist API not configured";
    if (ctx.hasUI) {
      ctx.ui.setStatus("apple-music", `Apple Music: ${playbackStatus}; ${playlistStatus}`);
    }
  });

  registerAppleMusicPlayback(pi);
  registerAppleMusicPlaylists(pi);

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
        "Capabilities:",
        "- Playback: local Music.app transport controls",
        "- Playlists: prompt-based proposal and creation",
        "",
        "Config sources:",
        "- APPLE_MUSIC_DEVELOPER_TOKEN",
        "- APPLE_MUSIC_USER_TOKEN",
        "- APPLE_MUSIC_STOREFRONT",
        "- .pi/apple-music.json",
        "- ~/.pi/agent/apple-music.json",
        "",
        "Playback commands:",
        "/apple-music-status",
        "/apple-music-play",
        "/apple-music-pause",
        "/apple-music-next",
        "/apple-music-prev",
        "/apple-music-shuffle on|off",
        "/apple-music-repeat off|one|all",
        "",
        "Playlist commands:",
        "/apple-music-playlist <description>",
        "/apple-music-propose <description>",
        "/apple-music-make <description>",
        "/apple-music-proposal [last|proposal-id]",
        "/apple-music-skipped [last|proposal-id]",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
