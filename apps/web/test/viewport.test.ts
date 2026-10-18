import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DESKTOP_QUERY, useViewport } from "../src/lib/viewport.js";
import { stubMatchMedia } from "./helpers/matchMedia.js";

afterEach(() => vi.unstubAllGlobals());

describe("useViewport", () => {
  it("uses the 1024 px breakpoint", () => {
    expect(DESKTOP_QUERY).toBe("(min-width: 1024px)");
  });

  it("is desktop when the query matches and mobile otherwise", () => {
    stubMatchMedia({ desktop: true });
    expect(renderHook(() => useViewport()).result.current).toBe("desktop");
    vi.unstubAllGlobals();
    stubMatchMedia({ desktop: false });
    expect(renderHook(() => useViewport()).result.current).toBe("mobile");
  });

  it("follows a resize across the breakpoint", () => {
    const { desktop } = stubMatchMedia({ desktop: false });
    const { result } = renderHook(() => useViewport());
    act(() => desktop.emit(true));
    expect(result.current).toBe("desktop");
  });

  it("is mobile where matchMedia does not exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useViewport()).result.current).toBe("mobile");
  });
});
