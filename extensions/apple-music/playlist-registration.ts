import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadProposal, summarizeSkippedTracks } from "./config.js";
import { runDescribedCommand, withPlaylistConfig } from "./command-helpers.js";
import { createCuratedPlaylist, previewCuratedPlaylist } from "./playlist-service.js";
import { appendAssistantTextMessage } from "./utils.js";

export function registerAppleMusicPlaylists(pi: ExtensionAPI) {
  pi.registerTool({
    name: "apple_music_preview_playlist",
    label: "Apple Music Playlist Preview",
    description: "Preview an Apple Music playlist proposal from a natural-language description before creating it.",
    promptSnippet: "Preview curated Apple Music playlists from natural-language mood, genre, vibe, and discovery descriptions.",
    promptGuidelines: [
      "Prefer apple_music_preview_playlist first when the user asks for a playlist, unless they explicitly ask to create it immediately.",
      "Show the proposed playlist name, genres, and tracklist so the user can review before creation.",
      "Interpret genre requests as curation requests, not literal title matching. Prefer representative artists, editorial playlist signals, and artist-led discovery.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Natural-language playlist brief, e.g. tropical house, deep house, jazzy soulful tunes" }),
      playlistName: Type.Optional(Type.String({ description: "Optional proposed playlist name" })),
      trackCount: Type.Optional(Type.Number({ minimum: 5, description: "How many tracks to include in the preview. Defaults to 25, or all tracks for discography requests." })),
      selectionSeed: Type.Optional(Type.String({ description: "Optional seed to reproduce a prior preview exactly." })),
    }),
    async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const config = await withPlaylistConfig(ctx);
      return previewCuratedPlaylist(config, params, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel, cwd: ctx.cwd });
    },
  });

  pi.registerTool({
    name: "apple_music_create_playlist",
    label: "Apple Music Playlist",
    description: "Create an Apple Music playlist from a natural-language description using the Apple Music catalog and curated Apple Music signals.",
    promptSnippet: "Create curated Apple Music playlists from natural-language mood, genre, vibe, and discovery descriptions.",
    promptGuidelines: [
      "Use apple_music_preview_playlist first when the user asks for a playlist, unless they explicitly ask to create it immediately or confirm a reviewed proposal.",
      "Use apple_music_create_playlist when the user explicitly asks to create now, skip preview, or confirms a reviewed playlist proposal.",
      "When confirming a reviewed preview, reuse the preview selectionSeed if it is available so the created playlist matches the reviewed tracklist exactly.",
      "Interpret genre requests as curation requests, not literal title matching. Prefer representative artists, editorial playlist signals, and artist-led discovery.",
      "When the user says things like 'I want to get into k-pop' or 'where should I start with jazz', treat that as a discovery request and build an accessible starter playlist.",
      "Use apple_music_transport for local Music.app playback controls like play, pause, skip, shuffle/random, repeat, volume, or playing a specific playlist.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Natural-language playlist brief, e.g. tropical house, deep house, jazzy soulful tunes" }),
      playlistName: Type.Optional(Type.String({ description: "Optional explicit playlist name" })),
      trackCount: Type.Optional(Type.Number({ minimum: 5, description: "How many tracks to include. Defaults to 25, or all tracks for discography requests." })),
      startPlaying: Type.Optional(Type.Boolean({ description: "If true, try to start playing the playlist locally after creating it." })),
      selectionSeed: Type.Optional(Type.String({ description: "Optional seed from a reviewed preview to recreate the exact same tracklist." })),
    }),
    async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const config = await withPlaylistConfig(ctx);
      return createCuratedPlaylist(pi, config, params, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel, cwd: ctx.cwd });
    },
  });

  const registerDescribedPlaylistCommand = (
    name: string,
    description: string,
    options: {
      usage: string;
      progressMessage: string;
      successMessage: string;
      failurePrefix: string;
      fallbackText: (description: string) => string;
      run: (description: string, ctx: any) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;
    },
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (args: any, ctx: any) => {
        await runDescribedCommand(pi, ctx, {
          args,
          ...options,
        });
      },
    });
  };

  const runPreview = async (description: string, ctx: any) => {
    const config = await withPlaylistConfig(ctx);
    return previewCuratedPlaylist(config, { description }, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel, cwd: ctx.cwd });
  };

  registerDescribedPlaylistCommand("apple-music-playlist", "Start collaborative Apple Music playlist planning from a text description", {
    usage: "/apple-music-playlist <description>",
    progressMessage: "Working on playlist preview...",
    successMessage: "Playlist preview ready.",
    failurePrefix: "Playlist preview failed",
    fallbackText: (description) => `Previewed playlist for ${description}.`,
    run: runPreview,
  });

  registerDescribedPlaylistCommand("apple-music-preview", "Preview an Apple Music playlist from a text description", {
    usage: "/apple-music-preview <description>",
    progressMessage: "Working on playlist preview...",
    successMessage: "Playlist preview ready.",
    failurePrefix: "Playlist preview failed",
    fallbackText: (description) => `Previewed playlist for ${description}.`,
    run: runPreview,
  });

  registerDescribedPlaylistCommand("apple-music-make", "Create an Apple Music playlist from a text description", {
    usage: "/apple-music-make <description>",
    progressMessage: "Working on playlist creation...",
    successMessage: "Playlist created.",
    failurePrefix: "Playlist creation failed",
    fallbackText: (description) => `Created playlist for ${description}.`,
    run: async (description, ctx) => {
      const config = await withPlaylistConfig(ctx);
      return createCuratedPlaylist(pi, config, { description }, { model: ctx.model, modelRegistry: ctx.modelRegistry, plannerModel: config.plannerModel, cwd: ctx.cwd });
    },
  });

  pi.registerCommand("apple-music-proposal", {
    description: "Show the last saved Apple Music proposal or a specific proposal id",
    handler: async (args: any, ctx: any) => {
      const proposalRef = args.trim() || "last";
      const proposal = await loadProposal(ctx.cwd, proposalRef);
      if (!proposal) {
        ctx.ui.notify("No Apple Music proposal found.", "warning");
        return;
      }

      const summary = [
        `Proposal: ${proposal.data.playlistName ?? "Untitled"}`,
        `Path: ${proposal.path}`,
        proposal.data.counts ? `Counts: ${proposal.data.counts.selectedCount ?? 0} selected, ${proposal.data.counts.skippedCount ?? 0} skipped, ${proposal.data.counts.candidateCount ?? 0} candidates` : "",
        proposal.data.createdPlaylist?.playlistId ? `Created playlist: ${proposal.data.createdPlaylist.playlistName} (${proposal.data.createdPlaylist.playlistId})` : "",
      ]
        .filter(Boolean)
        .join("\n");

      appendAssistantTextMessage(pi, ctx, summary);
      ctx.ui.notify(summary, "info");
    },
  });

  pi.registerCommand("apple-music-skipped", {
    description: "Show skipped tracks for the last saved Apple Music proposal or a specific proposal id",
    handler: async (args: any, ctx: any) => {
      const proposalRef = args.trim() || "last";
      const proposal = await loadProposal(ctx.cwd, proposalRef);
      if (!proposal) {
        ctx.ui.notify("No Apple Music proposal found.", "warning");
        return;
      }

      const text = [
        `Skipped tracks for: ${proposal.data.playlistName ?? "Untitled"}`,
        `Path: ${proposal.path}`,
        summarizeSkippedTracks(proposal.data),
      ].join("\n\n");

      appendAssistantTextMessage(pi, ctx, text);
      ctx.ui.notify(text, "info");
    },
  });
}
