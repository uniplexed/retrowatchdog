// Resolve the theme before first paint; same rule as src/lib/theme.ts.
(function () {
  var pref = "auto";
  try { pref = localStorage.getItem("theme") || "auto"; } catch (e) {}
  var dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = pref === "dark" || (pref !== "light" && dark) ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0b1220" : "#f4f6f9");
})();
