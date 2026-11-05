# Public launch

Internal notes. Thomas writes all public-facing prose; this file records only
decisions and the to-do list.

**Launch** means open-sourcing Tambourin and inviting other people to use it
and contribute to it. Cloud mode is out of scope for now.

## Decisions (2026-11-05)

- **Name: Tambourin**, with no "e". Domains are `tambourin.fm` and `tamb.fm`.
  The GitHub org is `tambourin-fm`. The CLI is `tamb`.
- **Nomenclature:** Tambourin is the *environment*, and GPI (graphical
  patching interface) is what you patch in. Say "environment", not "platform".
- **Character:** general-purpose and adaptable to the designer's intention,
  like Pd and monome. Minimalist, open, sensible.
- **Attribution:** Tambourin is by Thomas Capogreco. One short line or link
  says he performs as assembly, using Tambourin.
- **Thomas's library** (ewing~ and the others) is published separately, under
  assembly, and doesn't ship with the core.
- **Licence: AGPLv3**, replacing GPLv3. Cloud mode is the reason: GPL doesn't
  cover a server run as a hosted service.

## Fresh-repo checklist

- [ ] Repo in `tambourin-fm`, starting with one clean commit.
- [ ] `LICENSE` is the AGPLv3 text, with a copyright line naming Thomas
      Capogreco.
- [ ] The README says patches belong to their authors: the licence covers the
      environment, not the patches made with it (like SuperCollider's
      statement).
- [ ] The assembly library has an AGPL-compatible licence, at least for any JS
      or worklets that load into the runtime.
- [x] Rename the leftover "tambourine" strings in this repo (2026-11-05),
      including the SSID and password defaults, the Grid/Arc OSC prefix, the
      dnsmasq conf name and the help patch. The `docs/tambourine` branch name
      is unchanged.
- [ ] The old `tambourine.fm` and `tambourine-fm` still exist; decide whether
      to keep them as redirects.
- [ ] Decide on a CLA. The current lean is none, with a DCO (`Signed-off-by:`)
      optional.

## Getting a stranger running (2026-11-05)

The plan for accounts, certificates, modes and routers is in
`network-and-modes.md`, under "Direction for the launch". In short:

- Automate everything that doesn't take sides, in Bun, the same on every OS.
- Put the opinionated parts on the router: OpenWrt, with GL.iNet recommended.
- For other routers, teach the general principles.
- The modes are also the syllabus.

## Other areas

- **Hardware and support:** stay within the GL.iNet ecosystem for
  recommendations. A list of known-good phones and browsers is still to do.
- **First contact:** help patches are the canonical reference. A YouTube
  tutorial series teaches the modes ladder.
- **Core scope:** the monome OSC ecosystem (Grid, Arc via serialosc) stays in
  core. Scripts are OS-agnostic as far as possible. The ES-8 needs nothing
  specific: core needs multichannel output, with DC passed through (no DC
  blocker on ctrl).
- **Contributing:** many decisions still to make: tests, a guide to the code
  layout, which contributions are wanted, and how decisions are made.
- **Community:** medium term, a Discourse forum (`forum.tambourin.fm` or
  similar). Check whether Discourse still offers free hosting to open-source
  projects.
