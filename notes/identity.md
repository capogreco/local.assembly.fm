# Visual identity

Internal working notes. Thomas designs the identity and writes all public
prose; this file records decisions only.

## Principle

The identity is built from the environment's own materials: the editor's 20px
dot grid, its two line weights (1px control, 2.5px audio), its ports, and its
type (IBM Plex Mono).

## Construction rules (starting point, 2026-11-06)

- The grid unit is the editor's 20px.
- Strokes run at 0°, 45° and 90° only.
- Line weights come from the cables: 1px and 2.5px.
- Ports are square, and line ends are square.

## Elements (from the sketches)

- **The mark:** a square and the same square turned 45°, with optional ports
  at the eight points and an optional `T` at the hub.
- **Wordmarks:** the horizontal `TAMBOURIN` in single-weight geometric letters;
  the stacked TAM / BOU / RIN on a 3×3 grid (nine letters fill it exactly); and
  `tambourin.fm` on a cable between two ports.
- **Tagline draft:** "graphical patching interface for distributed synthesis".

## Colour (2026-11-06)

There are two modes, light and dark. Which one is the default where is
undecided.

| Role | Light ("warm white", the notebook) | Dark (the editor) |
|---|---|---|
| paper / ground | `#f6f4ee` | `#1a1a1a` |
| dots | `#bdbab2` | `#333` today: too faint, being revised |
| graphite (text, mark) | `#3f3e3b` | `#e0e0e0` |
| ruled line (box strokes, control cables) | `#bfbcb4` | `#666` |
| audio | `#2f5fc4` | `#8af` |
| event | `#c46f0e` | `#fa4` |

The swatch page is at https://claude.ai/artifact/G4emoCwn5sB8PnhEy1jfVc
(private).

## Open

- Whether the two line weights carry meaning in the logo.
- Upper or lower case.
- Which surface gets which element (favicon, CLI banner, phone join page,
  editor welcome, README, website, forum).
- The welcome animation: dots appear, the square turns 45°, and it resolves
  into the edit-mode canvas.
