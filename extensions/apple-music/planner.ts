import { complete, type UserMessage } from "@mariozechner/pi-ai";

import { GENRE_SEED_MAP, type SeedGenreEntry } from "./genre-seeds.js";
import type { PlannerRuntime, PlaylistPlan, PlaylistPlannerSuggestion } from "./types.js";
import { DISCOVERY_PATTERNS, STARTER_PATTERNS, containsNormalizedPhrase, hasPattern, normalizeText, splitPromptSegments, tokenize, unique } from "./utils.js";

export function detectDiscographyIntent(description: string): { discographyIntent: boolean; strictArtistOnly: boolean; targetArtist?: string } {
  const normalized = normalizeText(description);
  const discographyIntent = /(all (the )?(songs|tracks|albums)|every song|complete playlist|complete discography|discography|all available tracks|all albums|all eps|all singles)/i.test(
    description,
  );
  const strictArtistOnly = /(only songs by|only recordings by|do not include other artists|only the artist|all the .* songs)/i.test(description);

  const artistPatterns = [
    /all songs by\s+([^,.;]+)/i,
    /every song by\s+([^,.;]+)/i,
    /only songs by\s+([^,.;]+)/i,
    /only recordings by(?: the artist)?\s+([^,.;]+)/i,
    /all available tracks from\s+([^,.;]+)/i,
    /complete (?:playlist|discography)(?: of| for)?\s+([^,.;]+)/i,
    /all the\s+([^,.;]+?)\s+songs/i,
  ];

  let targetArtist: string | undefined;
  for (const pattern of artistPatterns) {
    const match = description.match(pattern);
    if (match?.[1]) {
      targetArtist = match[1].replace(/^(the artist )/i, "").trim();
      break;
    }
  }

  if (!targetArtist && discographyIntent) {
    const fallback = normalized
      .replace(/.*(?:by|of|from)\s+/, "")
      .split(/[,.;]/)[0]
      ?.trim();
    if (fallback) targetArtist = fallback;
  }

  return {
    discographyIntent,
    strictArtistOnly,
    targetArtist: targetArtist ? targetArtist.replace(/^all the\s+/i, "").trim() : undefined,
  };
}

export function buildPromptFacets(description: string, matchedEntries: SeedGenreEntry[], inferredGenres: string[], moods: string[]): string[] {
  const rawSegments = splitPromptSegments(description).map((segment) => normalizeText(segment));
  const matchedFacetAliases = matchedEntries.flatMap((entry) => [entry.canonicalGenre, ...(entry.aliases ?? []).slice(0, 2)]).map(normalizeText);

  return unique([...rawSegments, ...inferredGenres.map(normalizeText), ...matchedFacetAliases, ...moods.map(normalizeText)])
    .filter(Boolean)
    .filter((facet) => facet.length >= 3)
    .slice(0, 8);
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

async function resolvePlannerModel(runtime?: PlannerRuntime): Promise<any | undefined> {
  if (!runtime?.modelRegistry) return runtime?.model;

  if (runtime.plannerModel) {
    const [provider, ...rest] = runtime.plannerModel.split("/");
    const modelId = rest.join("/").trim();
    if (provider && modelId) {
      return runtime.modelRegistry.find(provider, modelId) ?? runtime.model;
    }
  }

  const available = await runtime.modelRegistry.getAvailable();
  const preferredHaiku = available.find((model: any) => model.provider === "anthropic" && String(model.id) === "claude-haiku-4-5-20251001");
  if (preferredHaiku) return preferredHaiku;

  const preferredGptMini = available.find((model: any) => model.provider === "openai-codex" && String(model.id) === "gpt-5.4-mini");
  if (preferredGptMini) return preferredGptMini;

  return runtime.model;
}

async function getLlmPlaylistPlannerSuggestion(
  description: string,
  heuristicPlan: PlaylistPlan,
  runtime?: PlannerRuntime,
): Promise<PlaylistPlannerSuggestion | undefined> {
  if (!runtime?.modelRegistry) return undefined;

  const plannerModel = await resolvePlannerModel(runtime);
  if (!plannerModel) return undefined;

  const auth = await runtime.modelRegistry.getApiKeyAndHeaders(plannerModel);
  if (!auth.ok || !auth.apiKey) return undefined;

  const systemPrompt = `You are a music curation planner for Apple Music playlist generation.

Your job is to convert a natural language request into a compact structured curation plan.
Focus on semantic understanding, regions/scenes/cultures, vocal preferences, moods, and useful search queries.
Do not explain anything. Return JSON only.

Output JSON shape:
{
  "inferredGenres": string[],
  "facets": string[],
  "queries": string[],
  "seedArtists": string[],
  "relatedArtists": string[],
  "moods": string[],
  "avoidTerms": string[],
  "notes": string[],
  "optionalDirections": string[],
  "clarifyingQuestions": string[],
  "familiarArtists": string[],
  "discoveryIntent": boolean,
  "starterIntent": boolean,
  "broadRequest": boolean
}

Rules:
- Prefer representative artists/scenes, not generic literal title matches.
- If the request mentions countries/regions/languages, reflect that in facets, queries, and artist selection.
- If the request mentions vocals, include that in facets/notes and pick artists where vocals make sense.
- Avoid junk terms like focus frequency, brain stimulation, study tones, binaural, 432hz unless explicitly requested.
- Keep arrays short and useful.
- Queries should be good Apple Music search queries, including blended region + style queries when relevant.
- If the request is nuanced, infer adjacent genres that help curation.
- optionalDirections should capture legitimate alternate interpretations worth asking the user about.
- clarifyingQuestions should be low-friction multiple-choice style questions the user can answer quickly.
- familiarArtists should include obvious canonical artists that some users may want excluded for discovery.`;

  const userPrompt = JSON.stringify(
    {
      request: description,
      heuristicPlan: {
        inferredGenres: heuristicPlan.inferredGenres,
        facets: heuristicPlan.facets,
        seedArtists: heuristicPlan.seedArtists,
        relatedArtists: heuristicPlan.relatedArtists,
        moods: heuristicPlan.moods,
        queries: heuristicPlan.queries,
        avoidTerms: heuristicPlan.avoidTerms,
      },
    },
    null,
    2,
  );

  const response = await complete(
    plannerModel,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userPrompt }],
          timestamp: Date.now(),
        } satisfies UserMessage,
      ],
    },
    { apiKey: auth.apiKey, headers: auth.headers },
  );

  if (response.stopReason !== "stop") return undefined;
  const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
  const json = extractJsonObject(text);
  if (!json) return undefined;

  return {
    inferredGenres: asStringArray(json.inferredGenres, 8),
    facets: asStringArray(json.facets, 10),
    queries: asStringArray(json.queries, 10),
    seedArtists: asStringArray(json.seedArtists, 12),
    relatedArtists: asStringArray(json.relatedArtists, 12),
    moods: asStringArray(json.moods, 8),
    avoidTerms: asStringArray(json.avoidTerms, 10),
    notes: asStringArray(json.notes, 6),
    optionalDirections: asStringArray(json.optionalDirections, 6),
    clarifyingQuestions: asStringArray(json.clarifyingQuestions, 4),
    familiarArtists: asStringArray(json.familiarArtists, 8),
    discoveryIntent: typeof json.discoveryIntent === "boolean" ? json.discoveryIntent : undefined,
    starterIntent: typeof json.starterIntent === "boolean" ? json.starterIntent : undefined,
    broadRequest: typeof json.broadRequest === "boolean" ? json.broadRequest : undefined,
  };
}

function mergePlaylistPlan(basePlan: PlaylistPlan, suggestion?: PlaylistPlannerSuggestion): PlaylistPlan {
  if (!suggestion) return basePlan;

  return {
    ...basePlan,
    inferredGenres: unique([...(suggestion.inferredGenres ?? []), ...basePlan.inferredGenres]).slice(0, 10),
    facets: unique([...(suggestion.facets ?? []), ...basePlan.facets]).slice(0, 10),
    queries: unique([...(suggestion.queries ?? []), ...basePlan.queries]).slice(0, 10),
    seedArtists: unique([...(suggestion.seedArtists ?? []), ...basePlan.seedArtists]).slice(0, 16),
    relatedArtists: unique([...(suggestion.relatedArtists ?? []), ...basePlan.relatedArtists]).slice(0, 16),
    moods: unique([...(suggestion.moods ?? []), ...basePlan.moods]).slice(0, 10),
    avoidTerms: unique([...(suggestion.avoidTerms ?? []), ...basePlan.avoidTerms]).map(normalizeText).filter(Boolean).slice(0, 16),
    optionalDirections: unique([...(suggestion.optionalDirections ?? []), ...basePlan.optionalDirections]).slice(0, 6),
    clarifyingQuestions: unique([...(suggestion.clarifyingQuestions ?? []), ...basePlan.clarifyingQuestions]).slice(0, 4),
    familiarArtists: unique([...(suggestion.familiarArtists ?? []), ...basePlan.familiarArtists]).slice(0, 8),
    notes: unique([...(suggestion.notes ?? []), ...basePlan.notes, "LLM-assisted plan"]).slice(0, 6),
    discoveryIntent: suggestion.discoveryIntent ?? basePlan.discoveryIntent,
    starterIntent: suggestion.starterIntent ?? basePlan.starterIntent,
    broadRequest: suggestion.broadRequest ?? basePlan.broadRequest,
    discographyIntent: basePlan.discographyIntent,
    strictArtistOnly: basePlan.strictArtistOnly,
    targetArtist: basePlan.targetArtist,
  };
}

export async function buildPlaylistPlan(description: string, runtime?: PlannerRuntime): Promise<PlaylistPlan> {
  const normalizedDescription = normalizeText(description);
  const matchedEntries: SeedGenreEntry[] = [];
  const { discographyIntent, strictArtistOnly, targetArtist } = detectDiscographyIntent(description);

  for (const [genreKey, entry] of Object.entries(GENRE_SEED_MAP)) {
    const phrases = unique([genreKey, entry.canonicalGenre, ...(entry.aliases ?? [])].map(normalizeText));
    if (phrases.some((phrase) => containsNormalizedPhrase(normalizedDescription, phrase))) {
      matchedEntries.push(entry);
    }
  }

  const inferredGenres = unique(
    matchedEntries.length > 0
      ? matchedEntries.map((entry) => entry.canonicalGenre)
      : splitPromptSegments(description).slice(0, 4).map((segment) => normalizeText(segment)),
  ).filter(Boolean);

  const seedArtists = unique(matchedEntries.flatMap((entry) => entry.seedArtists)).slice(0, 12);
  const relatedArtists = unique(matchedEntries.flatMap((entry) => entry.relatedArtists)).slice(0, 12);
  const moods = unique(matchedEntries.flatMap((entry) => entry.moods ?? [])).slice(0, 8);
  const avoidTerms = unique(
    [
      ...matchedEntries.flatMap((entry) => entry.avoidTerms ?? []),
      ...inferredGenres,
      "best of",
      "workout mix",
      "meditation music",
      "study beats",
      "concentration music",
      "focus music",
      "brain stimulation",
      "432 hz",
      "binaural",
    ].map(normalizeText),
  ).filter(Boolean);

  const facets = buildPromptFacets(description, matchedEntries, inferredGenres, moods);

  const regionTerms = ["japanese", "chinese", "asian", "mandarin", "japan", "china"];
  const regionalFacets = facets.filter((facet) => regionTerms.some((term) => containsNormalizedPhrase(facet, term)));
  const styleFacets = facets.filter((facet) => !regionTerms.some((term) => containsNormalizedPhrase(facet, term)));
  const compositeRegionalQueries = regionalFacets.flatMap((regionFacet) =>
    styleFacets.slice(0, 3).map((styleFacet) => `${regionFacet} ${styleFacet}`),
  );

  const queries = unique(
    [
      normalizedDescription,
      ...compositeRegionalQueries,
      ...facets.filter((facet) => tokenize(facet).length >= 2),
      ...matchedEntries.flatMap((entry) => entry.aliases.slice(0, 2)),
      ...moods.slice(0, 3).map((mood) => `${mood} ${inferredGenres[0] ?? "music"}`),
    ]
      .map((query) => normalizeText(query))
      .filter((query) => query.length >= 3),
  ).slice(0, 10);

  const discoveryIntent = hasPattern(DISCOVERY_PATTERNS, description);
  const starterIntent = discoveryIntent || hasPattern(STARTER_PATTERNS, description);
  const broadRequest = inferredGenres.length >= 3 || (inferredGenres.length === 0 && tokenize(description).length >= 5);
  const notes = unique(matchedEntries.map((entry) => entry.notes).filter((note): note is string => Boolean(note))).slice(0, 3);

  const heuristicPlan: PlaylistPlan = {
    originalDescription: description,
    normalizedDescription,
    inferredGenres,
    matchedSeedEntries: matchedEntries,
    facets,
    queries,
    seedArtists,
    relatedArtists,
    avoidTerms,
    optionalDirections: [],
    clarifyingQuestions: [],
    familiarArtists: [],
    discographyIntent,
    strictArtistOnly,
    targetArtist,
    discoveryIntent,
    starterIntent,
    broadRequest,
    moods,
    notes,
  };

  const llmSuggestion = await getLlmPlaylistPlannerSuggestion(description, heuristicPlan, runtime);
  return mergePlaylistPlan(heuristicPlan, llmSuggestion);
}
