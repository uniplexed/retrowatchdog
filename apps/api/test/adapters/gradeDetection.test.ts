import { describe, it, expect } from "vitest";
import { classifyListing, detectGradeFromTitle } from "../../src/adapters/classifyListing.js";

/**
 * The cosmetic grade a seller's own words claim — adapters/classifyListing.ts
 * detectGradeFromTitle, reading the shared GRADE_TIERS vocabulary.
 *
 * Nothing about it is one marketplace's: every adapter that reads seller prose
 * gets the same answer, which is what makes a "MINT" from one source
 * comparable with a "MINT" from another. The cases lived in the eBay test file
 * under the historic `detectEbayGrade` alias because that is where the
 * detector grew up; they are its only direct coverage, so they live with the
 * module now.
 *
 * Tier precedence is the load-bearing part (poor -> fair -> near_mint -> mint
 * -> very_good -> good, first hit wins) and several cases below exist only to
 * pin it.
 */

describe("grade detection from a listing title", () => {
  it("grades for-parts/faulty/damaged listings as poor", () => {
    // the real polluter: this listing must never drag a median nor look like a bargain
    expect(detectGradeFromTitle("Zelda Ocarina of Time N64 FAULTY — spares or repairs")).toBe("poor");
    expect(detectGradeFromTitle("SNES console bundle for parts")).toBe("poor");
    expect(detectGradeFromTitle("Mario Kart 64 cart spares/repairs")).toBe("poor");
    expect(detectGradeFromTitle("Game Boy Advance SP not working")).toBe("poor");
    expect(detectGradeFromTitle("Sonic 2 Mega Drive damaged cart")).toBe("poor");
    expect(detectGradeFromTitle("N64 console broken, untested")).toBe("poor");
    expect(detectGradeFromTitle("GoldenEye N64 faulty")).toBe("poor");
  });

  it("does NOT treat negated damage words as damage (no/not/never)", () => {
    expect(detectGradeFromTitle("Super Mario 64 cart, no damage")).toBeNull();
    expect(detectGradeFromTitle("Super Mario 64 cart, not damaged")).toBeNull();
    expect(detectGradeFromTitle("SNES console, never damaged, fully tested")).toBeNull();
    expect(detectGradeFromTitle("Game Boy pocket, not faulty, works fine")).toBeNull();
    // the negated word is ignored, but the REST of the title still grades
    expect(detectGradeFromTitle("Mario Kart 64 not damaged, VGC")).toBe("very_good");
    // unnegated damage still counts even when it's the box that's damaged
    expect(detectGradeFromTitle("Super Mario World SNES boxed PAL, box damaged")).toBe("poor");
  });

  it("grades heavy-wear vocabulary and the explicit 'poor' word as fair", () => {
    expect(detectGradeFromTitle("Pokemon Red Game Boy tatty box")).toBe("fair");
    expect(detectGradeFromTitle("Zelda OOT cart, play worn")).toBe("fair");
    expect(detectGradeFromTitle("Zelda OOT cart, play-worn label")).toBe("fair");
    expect(detectGradeFromTitle("Zelda OOT cart playworn")).toBe("fair");
    expect(detectGradeFromTitle("Mega Drive controller well used but working")).toBe("fair");
    expect(detectGradeFromTitle("Streets of Rage 2, heavy wear to label")).toBe("fair");
    expect(detectGradeFromTitle("Tetris GB poor condition but complete")).toBe("fair");
    expect(detectGradeFromTitle("F-Zero SNES box poor")).toBe("fair");
  });

  it("grades near-mint variants as near_mint, never as mint (precedence trap)", () => {
    expect(detectGradeFromTitle("Zelda Ocarina of Time N64 Near Mint")).toBe("near_mint");
    expect(detectGradeFromTitle("Zelda Ocarina of Time N64 near-mint boxed")).toBe("near_mint");
    expect(detectGradeFromTitle("Chrono Trigger SNES NR MINT")).toBe("near_mint");
    expect(detectGradeFromTitle("Chrono Trigger SNES NMINT cart")).toBe("near_mint");
    expect(detectGradeFromTitle("Zelda Ocarina of Time N64 Near Mint")).not.toBe("mint");
  });

  it("grades mint/pristine/immaculate as mint", () => {
    expect(detectGradeFromTitle("Super Mario World SNES PAL Boxed MINT!")).toBe("mint");
    expect(detectGradeFromTitle("Pokemon Blue Game Boy pristine")).toBe("mint");
    expect(detectGradeFromTitle("Gran Turismo PS1 immaculate condition")).toBe("mint");
  });

  it("accepts the documented 'Mint green' colour-word collateral as mint", () => {
    // In a bare title the colour word is indistinguishable from the grade
    // word; this false positive is accepted (see GRADE_TIERS doc-comment).
    expect(detectGradeFromTitle("Mint green Game Boy Advance console shell")).toBe("mint");
  });

  it("grades vgc/very good condition as very_good, beating its 'good condition' suffix", () => {
    expect(detectGradeFromTitle("Mario Kart 64 N64 PAL VGC")).toBe("very_good");
    expect(detectGradeFromTitle("Mario Kart 64 in very good condition")).toBe("very_good");
    expect(detectGradeFromTitle("Mario Kart 64 in very good condition")).not.toBe("good");
  });

  it("grades the 'good condition' phrase as good, but never the bare 'good' word", () => {
    expect(detectGradeFromTitle("Mario Kart 64 N64 in good condition")).toBe("good");
    expect(detectGradeFromTitle("Mario Kart 64 N64, a good game")).toBeNull();
  });

  it("lets damage tiers win over cosmetic praise (first tier hit wins)", () => {
    expect(detectGradeFromTitle("Zelda OOT N64 FAULTY but box is mint")).toBe("poor");
    expect(detectGradeFromTitle("SNES tatty but very good condition box")).toBe("fair");
  });

  it("returns null for titles with no grade vocabulary", () => {
    expect(detectGradeFromTitle("Super Mario World SNES PAL Boxed Complete")).toBeNull();
    expect(detectGradeFromTitle("Zelda Ocarina of Time N64 japan import")).toBeNull();
  });

  /**
   * The wiring, which is what a caller actually depends on: the detector's
   * answer reaches a normalized listing as `gradeGuess`. It travelled with the
   * grade cases from the eBay file, where it read through normalizeEbayListing
   * — a wrapper that adds `available: true` and nothing else — so it is
   * expressed here against the shared classifier every adapter's normalize()
   * runs, and against a plain RawListing rather than a Browse item summary.
   */
  it("wires the grade into a classified listing as gradeGuess", () => {
    const classified = (title: string) =>
      classifyListing({ sourceProductId: "v1|9007|0", title, url: null, prices: [] });
    expect(classified("Zelda Ocarina of Time N64 PAL Near Mint").gradeGuess).toBe("near_mint");
    expect(classified("Zelda Ocarina of Time N64 FAULTY spares or repairs").gradeGuess).toBe("poor");
    expect(classified("Zelda Ocarina of Time N64 PAL boxed").gradeGuess).toBeNull();
  });
});
