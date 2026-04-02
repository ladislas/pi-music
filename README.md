# Pi Apple Music Extension

Pi extension that:
- creates Apple Music playlists from natural-language descriptions
- controls the local Music app on macOS (`play`, `pause`, `next`, `previous`, shuffle/random, repeat, volume, playlist playback)

## What it can do

Examples:
- "Create an Apple Music playlist with tropical house, deep house, jazzy soulful tunes"
- "Pause Apple Music"
- "Skip this track"
- "Turn shuffle on"
- "Repeat this playlist"

## Setup

### 1) Local playback control
Playback control works on **macOS** through AppleScript and the built-in **Music** app.

No Apple Music web API token is needed for `play`, `pause`, `next`, `previous`, shuffle, repeat, or volume.

### 2) Playlist creation via Apple Music API
To create real playlists in your Apple Music account, configure:

- `developerToken`
- `musicUserToken`
- `storefront` (for example `us`, `fr`, `gb`)

You can configure them in either:
- environment variables
- `.pi/apple-music.json`
- `~/.pi/agent/apple-music.json`

Environment variables override file values.

#### Environment variables

```bash
export APPLE_MUSIC_DEVELOPER_TOKEN='...'
export APPLE_MUSIC_USER_TOKEN='...'
export APPLE_MUSIC_STOREFRONT='us'
```

#### Project config file

Copy the example file:

```bash
mkdir -p .pi
cp .pi/apple-music.example.json .pi/apple-music.json
```

Then fill in your Apple Music tokens.

## Install in pi

### Project-local

From this repo:

```bash
pi install . -l
```

Or run directly for testing:

```bash
pi -e ./extensions/apple-music/index.ts
```

## Usage inside pi

Natural language:
- "Create me a playlist with tropical house, deep house, jazzy soulful tunes"
- "Pause the music"
- "Turn shuffle on and skip"
- "Set repeat to all"
- "Play my playlist Sunset House"

Slash commands:
- `/apple-music-help`
- `/apple-music-status`
- `/apple-music-play`
- `/apple-music-pause`
- `/apple-music-next`
- `/apple-music-prev`
- `/apple-music-shuffle on`
- `/apple-music-repeat off|one|all`
- `/apple-music-make <description>`

## Notes

- Playlist creation needs valid Apple Music API credentials.
- Local transport controls currently target **macOS Music.app**.
- "random" is implemented via shuffle.
