function normalizeText(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s,/'&+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectDiscographyIntent(description) {
  const normalized = normalizeText(description);
  const discographyIntent = /(all (the )?(songs|tracks|albums)|every song|complete playlist|complete discography|discography|all available tracks|all albums|all eps|all singles)/i.test(
    description,
  );
  const strictArtistOnly = /(only songs by|only recordings by|do not include other artists|only the artist|all the .* songs|only\s+[\w .&'+-]+\s+songs)/i.test(description);

  const artistPatterns = [
    /all songs by\s+([^,.;]+)/i,
    /every song by\s+([^,.;]+)/i,
    /only songs by\s+([^,.;]+)/i,
    /only recordings by(?: the artist)?\s+([^,.;]+)/i,
    /all available tracks from\s+([^,.;]+)/i,
    /complete (?:playlist|discography)(?: of| for)?\s+([^,.;]+)/i,
    /all the\s+([^,.;]+?)\s+songs/i,
  ];

  let targetArtist;
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

export function classifyReleaseType(releaseName) {
  const normalized = normalizeText(releaseName);
  if (/\bep\b/.test(normalized)) return "ep";
  if (/\bsingle\b/.test(normalized)) return "single";
  return normalized ? "album" : "other";
}

export function hasVersionMarker(title) {
  return /(live|acoustic|alternate|alt\b|remix|version|session|demo|instrumental|piano solo|duet|edit)/i.test(title);
}

export function shouldIncludeAllSingles(plan) {
  return /all singles|include singles|keep singles/.test(plan.normalizedDescription);
}

export function shouldIncludeAlternateVersions(plan) {
  return /live|acoustic|alternate|remix|version|session|demo|instrumental|duet/.test(plan.normalizedDescription);
}

export function songArtistIncludesTarget(songArtistName, targetArtistName) {
  const normalizedSongArtist = normalizeText(songArtistName);
  const normalizedTargetArtist = normalizeText(targetArtistName);
  if (!normalizedSongArtist || !normalizedTargetArtist) return false;
  if (normalizedSongArtist === normalizedTargetArtist) return true;

  const artistParts = normalizedSongArtist
    .split(/,|&| feat\.? | featuring | with /)
    .map((part) => part.trim())
    .filter(Boolean);
  return artistParts.includes(normalizedTargetArtist);
}

export function buildDiscographySelection(candidates, plan, canonicalTrackSignature) {
  const includeAllSingles = shouldIncludeAllSingles(plan);
  const includeAlternateVersions = shouldIncludeAlternateVersions(plan);
  const selected = [];
  const skipped = [];
  const selectedIds = new Set();
  const coreSignatures = new Set();

  const pushSelected = (candidate) => {
    if (selectedIds.has(candidate.song.id)) return;
    selected.push(candidate);
    selectedIds.add(candidate.song.id);
  };

  const byReleaseType = (releaseType) => candidates.filter((candidate) => (candidate.sourceReleaseType ?? "other") === releaseType);

  for (const candidate of [...byReleaseType("album"), ...byReleaseType("ep")]) {
    pushSelected(candidate);
    coreSignatures.add(canonicalTrackSignature(candidate));
  }

  for (const candidate of [...byReleaseType("single"), ...byReleaseType("other")]) {
    const signature = canonicalTrackSignature(candidate);
    const isAlternate = hasVersionMarker(candidate.song.attributes?.name ?? "") || hasVersionMarker(candidate.sourceReleaseName ?? "");
    if (isAlternate && !includeAlternateVersions) {
      skipped.push({ ...candidate, skipReason: "alternate-version-excluded" });
      continue;
    }
    if (!includeAllSingles && coreSignatures.has(signature)) {
      skipped.push({ ...candidate, skipReason: "single-duplicate-of-album-or-ep" });
      continue;
    }
    pushSelected(candidate);
  }

  return { selectedCandidates: selected, skippedCandidates: skipped };
}
