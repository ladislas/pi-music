import test from "node:test";
import assert from "node:assert/strict";

import { detectDiscographyIntent } from "../extensions/apple-music/discography-logic.ts";

test("detectDiscographyIntent extracts artist for all songs by pattern", () => {
  const result = detectDiscographyIntent("all songs by SYML, complete discography, only SYML songs, all albums and EPs");
  assert.equal(result.discographyIntent, true);
  assert.equal(result.strictArtistOnly, true);
  assert.equal(result.targetArtist, "SYML");
});

test("detectDiscographyIntent extracts artist for complete discography of pattern", () => {
  const result = detectDiscographyIntent("complete discography of Bon Iver, all albums and EPs");
  assert.equal(result.discographyIntent, true);
  assert.equal(result.targetArtist, "Bon Iver");
});
