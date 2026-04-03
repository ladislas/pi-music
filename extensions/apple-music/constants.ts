export const APPLE_MUSIC_FOLDER_NAME = "piMusic";
export const APPLE_MUSIC_MOVE_INITIAL_DELAY_MS = 10_000;
export const APPLE_MUSIC_MOVE_RETRY_DELAY_MS = 2_500;
export const APPLE_MUSIC_MOVE_ATTEMPTS = 4;

export const TRANSPORT_ACTIONS = [
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
