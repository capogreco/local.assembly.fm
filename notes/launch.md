# Public launch: identity and repo checklist

Internal notes. Thomas writes all public-facing prose; this file records only
decisions and the to-do list.

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
- [ ] Decide on a CLA. The current lean is none.
