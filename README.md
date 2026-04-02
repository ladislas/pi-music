# Pi Apple Music Extension

Pi extension that:
- creates Apple Music playlists from natural-language descriptions
- places generated playlists inside the `piMusic` playlist folder in Apple Music
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

Generated playlists are organized under a `piMusic` folder in Apple Music. On macOS, the extension checks for that folder first and creates it automatically if it does not exist.

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

### 3) Get the Music User Token with the helper page

This repo now includes a small local helper page.

Start it with:

```bash
npm run token-helper
```

Then open:

```text
http://localhost:8787/music-user-token.html
```

What it does:
- you paste your Apple Music developer token
- it initializes MusicKit JS in the browser
- you sign in with Apple Music
- it returns the `musicUserToken`
- it shows a ready-to-copy JSON config snippet

Important:
- your Apple Music app configuration may need to allow `http://localhost:8787` as an origin
- you need an Apple Music subscription on the Apple account you sign in with
- if login fails, try Safari and make sure popups are allowed

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

When playlists are created through pi, they are intended to live inside the `piMusic` folder. If Apple Music library sync is delayed, a newly created playlist may briefly show as pending before it appears in Music.app and gets moved into the folder.

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
- Generated playlists are placed in the `piMusic` folder when Music.app can see them.
- "random" is implemented via shuffle.
- A local helper page is available at `helper/music-user-token.html`, served by `npm run token-helper`.
