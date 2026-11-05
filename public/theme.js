// Editor themes: one table, two palettes, one active theme.
//
// The canvas reads COLORS (mutated in place on a switch, so every importer
// sees the active palette). The page chrome reads CSS custom properties from
// theme.css, keyed on <html data-theme>. Both follow the same choice:
// the OS (prefers-color-scheme), live, until the user picks one; an explicit
// pick persists per browser in localStorage.
//
// Palette decisions: notes/identity.md. Values marked "start" are first
// guesses for Thomas to tune by eye.

const THEMES = {
  dark: {
    bg: "#1a1a1a",
    grid: "#5e5e5e",
    boxFill: "#2a2a2a", boxStroke: "#666",
    boxSelectedFill: "#333", boxSelectedStroke: "#e0e0e0",
    text: "#e0e0e0", port: "#e0e0e0", cable: "#666", cableInProgress: "#999",
    border: "#555", borderLabel: "#555", borderHandle: "#666",
    routerFill: "#2a2a2a", routerStroke: "#555",
    abstractionFill: "#2a2a3a", abstractionStroke: "#668",
    commentText: "#888",
    cableAudio: "#8af", portAudio: "#8af", portEvent: "#fa4",
    marquee: "#555",
    valueBar: "#4a4a4a",
    valueText: "#888",
    // Overlay labels (status, mode, patch name, devices, connection dot)
    labelMuted: "#555", labelStrong: "#aaa", labelDim: "#444",
    statusModified: "#865", statusApplied: "#686",
    absTitle: "#668", absTitleDirty: "#658",
  },
  light: {
    bg: "#f6f4ee",                 // paper
    grid: "#bdbab2",               // dots
    boxFill: "#fcfaf4",            // start
    boxStroke: "#bfbcb4",          // ruled line
    boxSelectedFill: "#eeece6",    // start
    boxSelectedStroke: "#3f3e3b",  // graphite
    text: "#3f3e3b", port: "#3f3e3b",
    cable: "#bfbcb4",              // ruled line
    cableInProgress: "#8f8d87",    // start
    border: "#cfccc4", borderLabel: "#8f8d87", borderHandle: "#a8a59d", // start
    routerFill: "#fcfaf4", routerStroke: "#cfccc4",                     // start
    abstractionFill: "#f0f0f6", abstractionStroke: "#8a8fb0",           // start
    commentText: "#8f8d87",        // start
    cableAudio: "#2f5fc4", portAudio: "#2f5fc4", portEvent: "#c46f0e",
    // Invented here (no decision yet):
    marquee: "#a8a59d",
    valueBar: "#e6e3db",
    valueText: "#8f8d87",
    labelMuted: "#a8a59d", labelStrong: "#3f3e3b", labelDim: "#bdbab2",
    statusModified: "#a8743a", statusApplied: "#5f8a5f",
    absTitle: "#8a8fb0", absTitleDirty: "#9a78b0",
  },
};

const STORAGE_KEY = "tambourin.theme";
const COLORS = { ...THEMES.dark };
const listeners = new Set();
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function storedTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v in THEMES ? v : null;
  } catch { return null; }
}

function osTheme() { return darkQuery.matches ? "dark" : "light"; }

let current = null;

function apply(name) {
  if (!(name in THEMES)) throw new Error(`unknown theme: ${name}`);
  if (name === current) return;
  current = name;
  Object.assign(COLORS, THEMES[name]);
  document.documentElement.dataset.theme = name;
  for (const fn of listeners) fn(name);
}

function currentTheme() { return current; }

// An explicit pick: applied and remembered in this browser.
function setTheme(name) {
  apply(name);
  try { localStorage.setItem(STORAGE_KEY, name); } catch { /* private window etc.: still applied */ }
}

function toggleTheme() { setTheme(current === "dark" ? "light" : "dark"); }

// Subscribe to theme changes; returns the unsubscribe function.
function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

apply(storedTheme() ?? osTheme());

// Follow the OS until the user picks.
darkQuery.addEventListener("change", () => { if (!storedTheme()) apply(osTheme()); });
// A pick in another tab or window (the abstraction editor) applies here too.
addEventListener("storage", (e) => { if (e.key === STORAGE_KEY) apply(storedTheme() ?? osTheme()); });

export { THEMES, COLORS, currentTheme, setTheme, toggleTheme, onThemeChange };
