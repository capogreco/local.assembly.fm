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
  cultural form. A `T` sits at the hub at the light weight, its crossbar 2 grid
  units wide. **Geometry:** square side 4 units (80px), on a native canvas of
  120px. **Ports** sit on the square's four corners, only at 96px and up.
  **Small sizes:** strokes scale with the mark but never go below 1px, so the
  weights converge when small. No retina-specific variants. The reference sheet is at
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

- **Favicon and app icons** (decided 2026-11-06): both squares at 1px, no
  ports; no `T` at 16px, with the `T` at 32 and 48px. The 180px Apple touch
  icon is the full mark (two weights, corner ports). All are on the paper
  tile. `deno task icons` (`icon-assets.ts`) draws them into `public/`. Drawn pixel by pixel at each size rather than shrunk. The mark is
  centred between the two middle pixels, so it sits symmetrically in
  even-sized squares and the turned square has 2px flat tips. The turned square
  steps one pixel per row. On the paper tile (PNG fallbacks, Apple touch icon)
  the mark is inset 1px. The candidates sheet is at
  https://claude.ai/artifact/G6m5LLKgAbxGVZcxsqoz6i (private).
- **Avatars** (GitHub org, lines, forum, YouTube): the two-weight mark, or
  TAM/BOU/RIN inside the square.
- **CLI banner** (decided 2026-11-06, after a terminal test): the horizontal
  `TAMBOURIN` alone, in light Unicode box drawing at 2 columns × 1 row per grid
  unit (3 rows tall), with no mark. Then a blank line, one lower-case status
  line, and the QR code. Current version (hand-tuned 2026-11-06; for now):

  ```
  ╶─┬─╴ ┌───┐ ┌─┬─┐ ╷     ┌───┐ ╷   ╷ ┌───┐  ╷  ╷╲  ╷
    │   ├───┤ │ ╵ │ ├───┐ │   │ │   │ ├─┬─┘  │  │ ╲ │
    ╵   ╵   ╵ ╵   ╵ └───┘ └───┘ └───┘ ╵  ╲   ╵  ╵  ╲╵
  ```

  The A has a flat top here (the p5 letter is pointed), so all but R and N are
  right angles. The lower-case-looking B is intentional. I and N sit tighter
  than the even spacing, for optical balance. Diagonals use `╲`, never ASCII
  `\`. Tested and set aside: the mark in braille (it reads, at 6 dots
  per unit, but sits awkwardly next to the word) and a braille wordmark (too
  faint). Box drawing can't do the mark: its diagonals are light only and
  don't join.
- **Editor welcome:** dots appear, the mark draws itself, the square turns 45°,
  TAM/BOU/RIN resolves, then it fades into the blank canvas with "press h".
  Skipped on the first gesture; reduced motion shows only the end state. It
  runs once per browser, with a replay link in the top-level help patch.
- **README header** (decided 2026-11-06): the horizontal `TAMBOURIN` with no
  separate mark; the O *is* the mark. Letters are 4 grid units tall, so the O
  is exactly the mark's square. The turned square sits on the O's centre, its
  points breaking the letter line, and there's no `T` at the hub, since the
  word already starts with one. Square ports on the O's corners (10px,
  outlined at the light weight, interiors cut out of the O so the ground shows
  through), an exception to the 96px rule for this hero moment. Transparent
  ground. Weights are
  nudged up 1px for the README (letters and O at 3.5px, turned square at 2px),
  so the turned square survives GitHub shrinking the image on phones. Diagonal
  strokes are cut flat at the cap height and baseline. Light and dark SVGs are
  in `assets/`, drawn by `deno task icons`. Candidates sheet:
  https://claude.ai/artifact/JMeHrLHCZQUnGA5a3TAw9E (private).
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

