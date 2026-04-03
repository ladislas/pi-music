import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { APPLE_MUSIC_FOLDER_NAME, TRANSPORT_ACTIONS } from "./constants.js";
import { transport } from "./transport.js";

export function registerAppleMusicPlayback(pi: ExtensionAPI) {
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
      const text = await transport(pi, APPLE_MUSIC_FOLDER_NAME, params.action, { playlistName: params.playlistName, volume: params.volume });
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
        const result = await transport(pi, APPLE_MUSIC_FOLDER_NAME, action, extra);
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
      const result = await transport(pi, APPLE_MUSIC_FOLDER_NAME, mode === "on" ? "shuffle_on" : "shuffle_off");
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
      const result = await transport(pi, APPLE_MUSIC_FOLDER_NAME, action);
      ctx.ui.notify(result, "info");
    },
  });
}
