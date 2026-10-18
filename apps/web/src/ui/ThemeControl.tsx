import { setThemePreference, useTheme, type ThemePreference } from "../lib/theme.js";
import { Segmented } from "./Segmented.js";

const OPTIONS: Array<{ value: ThemePreference; label: string; ariaLabel: string }> = [
  { value: "light", label: "☀", ariaLabel: "Light" },
  { value: "auto", label: "A", ariaLabel: "Auto" },
  { value: "dark", label: "☾", ariaLabel: "Dark" },
];

/** Light / Auto / Dark; the choice persists and applies at once. */
export function ThemeControl() {
  const { preference } = useTheme();
  return <Segmented aria-label="Theme" options={OPTIONS} value={preference} onChange={setThemePreference} />;
}
