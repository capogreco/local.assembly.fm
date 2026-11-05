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

- **The mark** (decided 2026-11-06): two *identical* squares, one turned 45°,
  so a true eight-pointed star. The turned square's points fall between the grid
  dots. The square is at the audio weight (2.5px): the instrument, the material
  form. The turned square is at the control weight (1px): the dance, the
  cultural form. A `T` sits at the hub at the light weight. Still open: the `T`'s
  size, ports, and the small-size rule. The reference sheet is at
  https://claude.ai/artifact/BgXAsuK92Qfugo4HoM5q7J (private).
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
| dots | `#bdbab2` | `#5e5e5e` (was `#333`, too faint) |
| graphite (text, mark) | `#3f3e3b` | `#e0e0e0` |
| ruled line (box strokes, control cables) | `#bfbcb4` | `#666` |
| audio | `#2f5fc4` | `#8af` |
| event | `#c46f0e` | `#fa4` |

The swatch page is at https://claude.ai/artifact/G4emoCwn5sB8PnhEy1jfVc
(private).

## Decided (2026-11-06)

- **Both line weights appear in the logo** (1px and 2.5px, as on the cables).
- **Case:** the geometric upper-case letters are for hero moments and the logo.
  Lower case is for prosaic surfaces.
- **Editor theme:** follows the OS by default, then `t` (or the dot) toggles
  between light and dark. There's no way back to "follow OS" from the UI, and
  that's intended.

## Surfaces (agreed in outline, 2026-11-06; details to come)

- **Favicon and app icons:** a small-size version of the mark (both squares at
  the heavy weight, no ports, maybe the `T`), redrawn for small sizes rather
  than shrunk.
- **Avatars** (GitHub org, lines, forum, YouTube): the two-weight mark, or
  TAM/BOU/RIN inside the square.
- **CLI banner:** Unicode box drawing, with light and heavy lines for the two
  weights and diagonals for the 45° strokes, then one lower-case status line
  and the QR code.
- **Editor welcome:** dots appear, the mark draws itself, the square turns 45°,
  TAM/BOU/RIN resolves, then it fades into the blank canvas with "press h".
  Skipped on the first gesture; reduced motion shows only the end state. It
  runs once per browser, with a replay link in the top-level help patch.
- **README header:** the mark with the horizontal TAMBOURIN, as SVG in light
  and dark versions.
- **Website hero:** the 3×3 stack in the mark, or the horizontal version.
  Everything else is lower case.
- **Video intros** reuse the welcome animation; thumbnails use the 3×3 stack.
- **Top-level help patch:** draws the mark out of real boxes and cables.
  (Thomas loves this.)
- **Cable lockup:** footers, end cards, the forum header, the README foot,
  venue QR posters.
- **Phone join page:** belongs to the piece. Tambourin is quiet there: the mark
  as the "tap to start audio" button, turning 45° when audio starts, and a
  lower-case "tambourin" credit.
- **Phone theme:** phones default to whatever theme the editor is set to.
- **The visual side of the phone client needs a proper paradigm,** so that
  performers can shape what phones show. Brainstorm with the interested
  TouchDesigner contributor after launch.

## Open

