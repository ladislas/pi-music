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
    action: (typeof TRANSPORT_ACTIONS)[number] | ((args: string, ctx: any) => (typeof TRANSPORT_ACTIONS)[number] | undefined),
    parse?: (args: string, ctx: any) => { playlistName?: string; volume?: number } | undefined,
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (args: any, ctx: any) => {
        const resolvedAction = typeof action === "function" ? action(args, ctx) : action;
        if (!resolvedAction) return;
        const extra = parse?.(args, ctx);
        if (extra === undefined) return;
        const result = await transport(pi, APPLE_MUSIC_FOLDER_NAME, resolvedAction, extra ?? {});
        ctx.ui.notify(result, "info");
      },
    });
  };

  registerTransportCommand("apple-music-status", "Show current Apple Music playback status", "status");
  registerTransportCommand("apple-music-play", "Play Apple Music", "play");
  registerTransportCommand("apple-music-pause", "Pause Apple Music", "pause");
  registerTransportCommand("apple-music-next", "Skip to the next track", "next");
  registerTransportCommand("apple-music-prev", "Go to the previous track", "previous");

  const parseMode = <T extends string>(
    value: string,
    allowed: readonly T[],
    usage: string,
    ctx: any,
  ): T | undefined => {
    const normalized = value.trim().toLowerCase() as T;
    if (!allowed.includes(normalized)) {
      ctx.ui.notify(`Usage: ${usage}`, "warning");
      return undefined;
    }
    return normalized;
  };

  registerTransportCommand(
    "apple-music-shuffle",
    "Set Apple Music shuffle on or off: /apple-music-shuffle on|off",
    (args, ctx) => {
      const mode = parseMode(args, ["on", "off"] as const, "/apple-music-shuffle on|off", ctx);
      return mode ? (mode === "on" ? "shuffle_on" : "shuffle_off") : undefined;
    },
  );

  registerTransportCommand(
    "apple-music-repeat",
    "Set Apple Music repeat mode: /apple-music-repeat off|one|all",
    (args, ctx) => {
      const mode = parseMode(args, ["off", "one", "all"] as const, "/apple-music-repeat off|one|all", ctx);
      return mode ? (mode === "off" ? "repeat_off" : mode === "one" ? "repeat_one" : "repeat_all") : undefined;
    },
  );
}
