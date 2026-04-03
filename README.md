# Pi Apple Music Extension

Pi extension that:

- proposes and creates Apple Music playlists from natural-language descriptions
- supports collaborative playlist planning with follow-up refinement directions
- stores proposal files under `.pi/apple-music-proposals/` so previews can be inspected, reused, and refined later
- places generated playlists inside the `piMusic` playlist folder in Apple Music
- stores prompt/refinement metadata in playlist descriptions for later evolution
- controls the local Music app on macOS (`play`, `pause`, `next`, `previous`, shuffle/random, repeat, volume, playlist playback)

Internally, the extension is split into two capability areas:

- **Playback**: local Music.app transport control
- **Playlists**: prompt interpretation, curation, proposal, refinement, and creation

`extensions/apple-music/index.ts` now acts as a thin composition layer that registers both sides.

## What it can do

Examples:

- "Make me a playlist with tropical house, deep house, jazzy soulful tunes"
- "Propose a playlist with tropical house, deep house, jazzy soulful tunes"
- "Create an Apple Music playlist with tropical house, deep house, jazzy soulful tunes"
- "I want Chinese and Japanese lo-fi electronic music to study, concentrate and code"
- "Pause Apple Music"
- "Skip this track"
- "Turn shuffle on"
- "Repeat this playlist"

## Setup

There are two setup levels:

1. **Playback only**: works locally on macOS with no Apple developer setup.
2. **Playlist creation**: requires Apple Music API credentials and a one-time Apple developer setup.

### 1) Local playback control
Playback control works on **macOS** through AppleScript and the built-in **Music** app.

No Apple Music web API token is needed for:

- `play`
- `pause`
- `next`
- `previous`
- shuffle
- repeat
- volume

### 2) What playlist creation needs

To create playlists in your Apple Music account, this extension needs:

- a **developer token**
- a **music user token**
- your **storefront** (for example `us`, `fr`, `gb`)

Generated playlists are organized under a `piMusic` folder in Apple Music. The extension now tries to create playlists directly in that folder through the Apple Music API `parent` relationship. On macOS, AppleScript folder creation/move remains as a fallback if needed.

You can configure credentials in either:

- environment variables
- `.pi/apple-music.json`
- `~/.pi/agent/apple-music.json`

Environment variables override file values.

Optional config:

- `plannerModel`: override the model used for LLM-assisted playlist interpretation
- `APPLE_MUSIC_PLANNER_MODEL`: environment-variable override for `plannerModel`

### 3) Easiest flow

If you want the shortest path, do this:

1. Set up Apple Music API access in the Apple Developer portal
2. Generate a developer token with the included script
3. Run the local helper page
4. Sign in with your Apple Music account in the browser
5. Copy the generated `musicUserToken`
6. Save both tokens into `.pi/apple-music.json`

### 4) Apple Developer portal steps

This extension is currently **local-only**. That means **you provide your own Apple Music API credentials**.

You will need:

- an Apple Developer account
- an Apple Music-capable app/service identifier setup in Apple Developer
- a MusicKit key (`.p8`)
- the key id
- your Apple team id
- an Apple account with an active Apple Music subscription

Typical Apple setup flow:

1. Open the Apple Developer portal
2. Create or choose an identifier/app configuration that will be used for MusicKit
3. Enable Apple Music / MusicKit for that app configuration if required
4. Add `http://localhost:8787` as an allowed origin if your setup requires web authorization origins
5. Create a **MusicKit private key**
6. Copy the **Key ID**
7. Copy your **Team ID**
8. Download the `.p8` private key file and keep it somewhere safe

Useful Apple pages:

- Apple Developer account: <https://developer.apple.com/account/>
- Certificates, Identifiers & Profiles: <https://developer.apple.com/account/resources/>
- MusicKit docs: <https://developer.apple.com/musickit/>
- Apple Music API docs: <https://developer.apple.com/documentation/applemusicapi>

### 5) Generate the developer token locally

This repo includes a helper script for generating a developer token from your Apple private key (`.p8`).

Run:

```bash
npm run generate-developer-token -- --team-id <APPLE_TEAM_ID> --key-id <APPLE_KEY_ID> --private-key <PATH_TO_AUTHKEY_P8> [--days 180]
```

Example:

```bash
npm run generate-developer-token -- \
  --team-id ABC123XYZ9 \
  --key-id 1A2BC3D4E5 \
  --private-key ~/Downloads/AuthKey_1A2BC3D4E5.p8
```

You can also provide these via environment variables:

- `APPLE_TEAM_ID`
- `APPLE_KEY_ID`
- `APPLE_PRIVATE_KEY_PATH`
- `APPLE_TOKEN_DAYS`

The script prints the JWT developer token to stdout.

### 6) Run the local helper page and get the Music User Token

This repo includes a local helper page that makes the browser-based Apple Music sign-in flow easier.

Start it with:

```bash
npm run token-helper
```

Then open:

```text
http://localhost:8787/music-user-token.html
```

The helper page explains the setup again and walks you through:

- pasting your developer token
- configuring MusicKit in the browser
- signing into Apple Music
- copying the returned `musicUserToken`
- copying a ready-to-save JSON config snippet

Important:

- your Apple Music app configuration may need to allow `http://localhost:8787` as an origin
- you need an Apple Music subscription on the Apple account you sign in with
- if login fails, try Safari and make sure popups are allowed

### 7) Save the config

#### Environment variables

```bash
export APPLE_MUSIC_DEVELOPER_TOKEN='...'
export APPLE_MUSIC_USER_TOKEN='...'
export APPLE_MUSIC_STOREFRONT='us'
```

#### Project config file

```bash
mkdir -p .pi
cat > .pi/apple-music.json <<'EOF'
{
  "developerToken": "PASTE_DEVELOPER_TOKEN_HERE",
  "musicUserToken": "PASTE_MUSIC_USER_TOKEN_HERE",
  "storefront": "us",
  "plannerModel": "anthropic/claude-haiku-4-5-20251001"
}
EOF
```

You can also store the same file in:

```text
~/.pi/agent/apple-music.json
```

### 8) Verify it works

Once configured, try one of these:

- "Propose a playlist with tropical house, deep house, jazzy soulful tunes"
- "Create an Apple Music playlist with tropical house, deep house, jazzy soulful tunes"
- `/apple-music-playlist tropical house, deep house, jazzy soulful tunes`
- `/apple-music-propose tropical house, deep house, jazzy soulful tunes`
- `/apple-music-make tropical house, deep house, jazzy soulful tunes`
- `/apple-music-proposal last`
- `/apple-music-skipped last`
- `/apple-music-status`

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

- "Propose a playlist with tropical house, deep house, jazzy soulful tunes"
- "Create me a playlist with tropical house, deep house, jazzy soulful tunes"
- "Pause the music"
- "Turn shuffle on and skip"
- "Set repeat to all"
- "Play my playlist Sunset House"

For playlist generation, the preferred UX is collaborative planning or proposal first, then create on confirmation. If the prompt is ambiguous, the extension can surface high-confidence picks, optional directions, familiar artists, and quick refinement questions instead of pretending the first result is perfect. If the user explicitly says to create immediately, pi can bypass the proposal step.

When playlists are created through pi, the extension first tries to place them directly in the `piMusic` folder through the Apple Music API. On macOS, AppleScript folder creation/move is still used as a fallback if library folder placement through the API is unavailable.

Created playlist descriptions store compact metadata including the original prompt, inferred refinements, and selection seed so the playlist can be evolved later.

Slash commands:

- `/apple-music-help`
- `/apple-music-status`
- `/apple-music-play`
- `/apple-music-pause`
- `/apple-music-next`
- `/apple-music-prev`
- `/apple-music-shuffle on|off`
- `/apple-music-repeat off|one|all`
- `/apple-music-playlist <description>`
- `/apple-music-propose <description>`
- `/apple-music-make <description>`
- `/apple-music-proposal [last|proposal-id]`
- `/apple-music-skipped [last|proposal-id]`

Proposal files are written to `.pi/apple-music-proposals/`. They capture the generated tracklist, candidate ranking, skipped tracks, playlist plan metadata, and selection seed so you can inspect or reproduce a preview later.

## Architecture

Key files:

- `extensions/apple-music/playback-registration.ts`: playback tool + slash commands
- `extensions/apple-music/playlist-registration.ts`: playlist tool/command registration only
- `extensions/apple-music/playlist-service.ts`: playlist curation, proposal, and creation domain logic
- `extensions/apple-music/transport.ts`: low-level AppleScript transport helpers
- `extensions/apple-music/index.ts`: extension composition and shared status/help wiring

This keeps direct player control separate from recommendation and playlist-building logic, while also keeping pi-specific registration thin and orchestration-friendly.

## Notes

- Playlist creation needs valid Apple Music API credentials.
- Local transport controls currently target **macOS Music.app**.
- Generated playlists are placed in the `piMusic` folder, preferably via the Apple Music API `parent` relationship, with AppleScript fallback on macOS.
- Playlist descriptions store compact provenance data: prompt, refinements, and selection seed.
- Preview and creation runs can persist proposal JSON files under `.pi/apple-music-proposals/` for later review.
- The planner combines heuristic Apple Music curation logic with an LLM-assisted interpretation layer for more nuanced prompts.
- You can optionally override the planner model with `APPLE_MUSIC_PLANNER_MODEL` or `plannerModel` in config.
- "random" is implemented via shuffle.
- A local helper page is available at `helper/music-user-token.html`, served by `npm run token-helper`.
