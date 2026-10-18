import { describe, it, expect } from "vitest";
import {
  numeralCompatible,
  numeralTokens,
  numeralSetsEqual,
} from "../../src/matching/numerals.js";

describe("numeralTokens", () => {
  // the spec's unit table, verbatim (import-matching v2, A1)
  it.each<[string, string[]]>([
    ["Street Fighter II", ["2"]],
    ["Street Fighter 2", ["2"]],
    ["Mega Man IV", ["4"]],
    ["Mega Man 4", ["4"]],
    ["Sonic the Hedgehog", []],
    ["Sonic the Hedgehog 2", ["2"]],
    ["Monster Hunter X", ["10"]],
    ["Monster Hunter 4 Ultimate", ["4"]],
    ["SimCity 2000", ["2000"]],
    ["F-1 Race", ["1"]],
    ["F1 Race", ["1"]],
    // a trailing letter is split off a digit run too: Japan's "4G" is 4 Ultimate, "3D" is a 3
    ["Monster Hunter 4G", ["4"]],
    ["Ocarina of Time 3D", ["3"]],
    // ...unless the letter is a roman numeral: "32X" stays one non-numeral token
    ["Knuckles' Chaotix 32X", []],
  ])("extracts %j -> %j", (title, expected) => {
    expect(numeralTokens(title)).toEqual(new Set(expected));
  });

  it("roman/arabic pairs agree (no penalty)", () => {
    const agree = (a: string, b: string): boolean =>
      numeralSetsEqual(numeralTokens(a), numeralTokens(b));
    expect(agree("Street Fighter II", "Street Fighter 2")).toBe(true);
    expect(agree("Mega Man IV", "Mega Man 4")).toBe(true);
    expect(agree("SimCity 2000", "SimCity 2000")).toBe(true);
    expect(agree("F-1 Race", "F1 Race")).toBe(true);
  });

  it("flags the wrong-sibling pairs from the live import", () => {
    const agree = (a: string, b: string): boolean =>
      numeralSetsEqual(numeralTokens(a), numeralTokens(b));
    expect(agree("Sonic the Hedgehog", "Sonic the Hedgehog 2")).toBe(false);
    expect(agree("Monster Hunter X", "Monster Hunter 4 Ultimate")).toBe(false);
  });
});

describe("numeralCompatible (the one predicate the matcher and the sweep share)", () => {
  it("accepts a listing whose numerals match the primary title", () => {
    expect(numeralCompatible("mega man iv", { primaryTitle: "Mega Man 4", names: ["Mega Man 4"] })).toBe(true);
    expect(numeralCompatible("street fighter ii turbo", { primaryTitle: "Street Fighter II Turbo", names: [] })).toBe(true);
  });

  it("accepts a listing whose numerals match an alternative name even when the primary's differ (R2)", () => {
    // a regional retitle: the listing is named after the alt name, not the primary
    expect(numeralCompatible("lylat wars", { primaryTitle: "Star Fox 64", names: ["Lylat Wars"], platform: "snes" })).toBe(true);
    expect(numeralCompatible("super probotector alien rebels", {
      primaryTitle: "Contra III: The Alien Wars", names: ["Super Probotector: Alien Rebels"],
    })).toBe(true);
    // without the alt name the same listing is a mismatch against the primary
    expect(numeralCompatible("super probotector alien rebels", { primaryTitle: "Contra III: The Alien Wars", names: [] })).toBe(false);
  });

  it("still rejects the measured wrong siblings: no numerals vs some numerals IS a mismatch", () => {
    expect(numeralCompatible("final fantasy vi advance", {
      primaryTitle: "Final Fantasy Tactics Advance", names: ["Final Fantasy Tactics Advance"],
    })).toBe(false);
    expect(numeralCompatible("sonic the hedgehog", { primaryTitle: "Sonic the Hedgehog 2", names: ["Sonic the Hedgehog 2"] })).toBe(false);
    expect(numeralCompatible("probotector", { primaryTitle: "Probotector 2", names: [] })).toBe(false);
    expect(numeralCompatible("sim city", { primaryTitle: "SimCity 2000", names: [], year: 1993 })).toBe(false);
  });

  it("reads a year-like token near the game's release year as a year, not a sequel numeral", () => {
    // IGDB carries the JP 1996 release; the UK seller wrote the 1999 EU one
    expect(numeralCompatible("pokemon red version 1999", { primaryTitle: "Pokémon Red Version", names: [], year: 1996 })).toBe(true);
    expect(numeralCompatible("mario kart 64 1996", { primaryTitle: "Mario Kart 64", names: [], year: 1996, platform: "n64" })).toBe(true);
    // a numbered sibling is NOT a year: SimCity 2000 vs SimCity (1989) stays apart
    expect(numeralCompatible("simcity 2000", { primaryTitle: "SimCity", names: [], year: 1989 })).toBe(false);
    // and without a known release year nothing is forgiven
    expect(numeralCompatible("pokemon red version 1999", { primaryTitle: "Pokémon Red Version", names: [], year: null })).toBe(false);
  });

  it("forgives the N64 brand suffix a listing omits, on N64 only", () => {
    // cleanTitle strips "N64"/"Nintendo 64" from "Mario Kart N64", leaving "mario kart"
    expect(numeralCompatible("mario kart", { primaryTitle: "Mario Kart 64", names: [], platform: "n64" })).toBe(true);
    expect(numeralCompatible("star fox", { primaryTitle: "Star Fox 64", names: [], platform: "n64" })).toBe(true);
    expect(numeralCompatible("mario kart", { primaryTitle: "Mario Kart 64", names: [], platform: "snes" })).toBe(false);
    // the other direction is never forgiven: a listing that says 64 wants a 64 title
    expect(numeralCompatible("mario party 64", { primaryTitle: "Mario Party", names: [], platform: "n64" })).toBe(false);
  });
});
