# Apple Music playlist generation plan

## Context
The current playlist generator is working again, but repeated runs can produce nearly identical playlists with the same songs in the same order.

Example observed:
- `Test #1` and `Test #3` ended up with the exact same songs
- even though the prompts were not exactly the same

This happens because the current pipeline is highly deterministic.

## How playlist generation works today

### 1. Prompt analysis
The prompt is normalized and matched against genre seed metadata from `extensions/apple-music/genre-seeds.js`.

From that, the system derives:
- inferred genres
- seed artists
- related artists
- mood terms
- search queries
- some avoid terms

### 2. Candidate collection
The extension then builds a candidate pool from Apple Music catalog signals:
- direct song search
- artist top songs
- album tracks
- playlist tracks
- editorial playlist tracks

### 3. Candidate scoring
Each song candidate gets a weighted score based on signals such as:
- direct song hits
- artist top song hits
- album track hits
- playlist track hits
- editorial playlist hits
- seed artist hits
- related artist hits
- query matches
- genre matches

The weights are hardcoded.

### 4. Final selection
Candidates are sorted by score descending.

The selection step then:
- walks the ranked list top to bottom
- applies only light artist diversity constraints
- selects the first songs that fit

This means that for the same or similar prompt, the output is often the same.

## Current UX / product issues

### Determinism
Repeated runs produce the same playlist too often.

### Weak diversity
The selector mostly preserves the highest-ranked candidates, so a few seed artists can dominate.

### Weak prompt facet balancing
A multi-part request like:
- tropical house
- deep house
- jazzy soulful tunes

can collapse toward the strongest-ranked facet instead of balancing the requested moods/genres.

### No history awareness
The generator does not currently remember:
- recently generated playlists
- recently used tracks
- recently used artists

So it can easily repeat itself across runs.

## Goals

We want generated playlists to be:
- relevant to the prompt
- more varied across runs
- better balanced across requested genres / moods
- less repetitive across songs, artists, and ordering
- still deterministic enough when needed for preview -> confirm flows

## Proposed improvements

### 1. Shuffle within score bands
Instead of selecting from one strict ranked list, group candidates into score tiers or bands, then shuffle within a band.

Benefits:
- preserves relevance
- avoids identical ordering every time
- introduces small variations without destroying quality

Implementation ideas:
- define bands by score deltas or percentiles
- keep the top band strong, but randomize within it
- optionally use a seeded RNG so preview/create can stay stable if needed

### 2. Stronger diversity constraints
Increase selection diversity rules.

Possible constraints:
- max 1 track per artist for smaller playlists
- max 1 track per album
- max N tracks per seed-artist cluster
- avoid consecutive tracks from the same subgenre or same source playlist

Benefits:
- prevents a few artists from dominating
- makes playlists feel more curated
- increases variety without lowering relevance too much

### 3. Recent-history suppression
Track what was used recently and penalize repeats.

Possible scopes:
- session memory only
- local cache persisted to disk

Possible penalties:
- recently used song IDs
- recently used artist names / IDs
- recently used playlist names

Benefits:
- avoids generating clones across adjacent runs
- makes repeated requests feel fresher

Questions to decide:
- session-only or persisted cache?
- how long should history last?
- should history be per prompt family or global?

### 4. Weighted random selection from the top candidate pool
Instead of always taking the highest-ranked tracks, sample from a top slice of candidates.

Possible approach:
- take top 40-60 candidates
- select tracks using weighted randomness based on score
- re-weight after each selection to maintain diversity

Benefits:
- adjacent playlists stay on-theme but not identical
- top-ranked songs still appear often, but not always all together

### 5. Better balancing across prompt facets
For prompts containing multiple genres, vibes, or moods, explicitly balance across them.

Example prompt:
- tropical house
- deep house
- jazzy soulful tunes

Possible approach:
- infer facets from prompt segments
- allocate target slots per facet
- score songs both globally and by facet affinity
- ensure final playlist covers all requested facets

Benefits:
- results match user intent more faithfully
- broad prompts feel intentionally blended
- reduces collapse toward just one dominant seed cluster

### 6. Preserve exact preview -> create behavior
Variation should not break the reviewed-preview flow.

Requirement:
- preview should show the exact tracklist that create will use on confirmation
- direct create may allow fresh variation
- create-from-preview should be exact and stable

This likely means:
- use a shared playlist proposal object
- optionally use a seeded RNG stored with the preview result

## Recommended implementation order

### Phase 1: easiest / highest impact
1. Add stronger diversity constraints
2. Add shuffle within score bands
3. Add weighted random selection from a top pool

Expected outcome:
- repeated playlists become less identical
- output remains high quality

### Phase 2: improve prompt fidelity
4. Add facet balancing for multi-part prompts

Expected outcome:
- broad prompts feel more intentionally blended

### Phase 3: improve memory across runs
5. Add recent-history suppression

Expected outcome:
- adjacent generated playlists feel fresher over time

### Phase 4: stabilize preview/create behavior
6. Ensure preview -> confirm uses the exact reviewed proposal

Expected outcome:
- variation for discovery
- stability for confirmation

## Open design questions
- Should variation be default, or only used when generating from a raw prompt?
- Should preview results be deterministic for a given session?
- Should there be a `variation` or `freshness` parameter?
- Should duplicate-avoidance be song-level, artist-level, or both?
- Should recently generated songs be penalized globally or only for similar prompts?

## Suggested technical tasks

### Selection and scoring
- [x] Review current scoring weights in `extensions/apple-music/index.ts`
- [x] Add score-band grouping helper
- [x] Add weighted random selector
- [x] Add stronger diversity constraints in `selectPlaylistSongs`
- [x] Add album-level diversity constraint

### Prompt structure / balancing
- [x] Parse prompt into facets more explicitly
- [x] Score candidates per facet
- [ ] Add slot allocation across facets
- [ ] Ensure final playlist covers all major requested facets

### History
- [ ] Define in-memory recent history structure
- [ ] Decide whether to persist history to disk
- [ ] Add recent-song penalty
- [ ] Add recent-artist penalty
- [ ] Add recency decay / expiry

### Preview / create stability
- [x] Store exact reviewed proposals for confirmation flows
- [x] Ensure create-from-preview does not recompute selection
- [x] Decide how random seed should be stored and reused

### Testing
- [x] Re-run the same prompt multiple times and compare overlap
- [ ] Test similar prompts and compare overlap
- [ ] Test multi-facet prompts for balance
- [ ] Test preview -> create stability
- [x] Test direct-create bypass behavior

## Success criteria
A successful next version should:
- avoid identical playlists across repeated runs of the same prompt
- vary order and composition while staying on-theme
- better balance multiple genres / moods in a single request
- reduce artist repetition
- preserve exact preview -> create confirmation behavior

## Immediate next step
Implement a first variation pass in the selector:
1. stronger diversity constraints
2. weighted selection from top candidates
3. shuffle within score bands

That should already make repeated playlists feel meaningfully different without requiring a large redesign.
