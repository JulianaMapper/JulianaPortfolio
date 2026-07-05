# julianamapper.com — Critique & Fix List

_Reviewed 2026-07-01. Site is served via GitHub Pages from this `docs/` folder._

The design itself is genuinely good — cream/forest palette, Lora + DM Sans, tasteful
drifting orbs, reduced-motion handled, real accessibility touches (aria labels, focus
states). This is a critique of a *good* site. But there's one embarrassing thing and a
pile of specific, cheap fixes.

---

## 🔥 Fix today — the site is serving a browser security warning

**HTTPS is broken.** Typing `julianamapper.com` in a real browser returns a full-screen
"Your connection is not private" error — not the site. The TLS certificate being served
is `*.github.io`, **not** a cert for the custom domain. GitHub Pages never provisioned
the custom-domain certificate.

Evidence:
- `https://julianamapper.com` → `SSL: no alternative certificate subject name matches` → browser wall
- `http://julianamapper.com` (plain) → `200 OK`, loads fine

Impact: anyone clicking an `https://` link (LinkedIn, email signature, Google) or whose
browser auto-upgrades to https sees a security warning. Worst possible first impression
for a CPO's portfolio — and invisible if you've only ever visited over http.

**Fix:** GitHub repo → **Settings → Pages** → remove the custom domain, save, re-add it,
save. That re-triggers Let's Encrypt issuance. After the cert provisions (up to ~1 hr),
check **"Enforce HTTPS."** If it won't provision, check DNS for a stray `CAA` record
blocking Let's Encrypt.

---

## Content & credibility

- **Testimonial carousel: Dr. Jim Westervelt is 3 of the 5 quotes.** Reads like you have
  three references, not five. Keep his single strongest quote (*"figures out what you
  actually need"*) and swap the other two for distinct voices — ideally a
  **public-health / client** voice, since PH360 is the flagship and there's no PH
  customer quote on the homepage.
- **Contact is a personal Gmail** — `JulianaMcMillanWilhoit@Gmail.com`. You're pitching
  as co-founder of F&T Labs. Use `juliana@fandtlabs.com` — branded, matches the company.
- **Title consistency:** the site commits to "Chief Product Officer & Co-Founder"
  (appears 3×). Make sure that's the title used everywhere (LinkedIn, other bios). Pick
  one and be consistent.
- **PH360 → PH360™** on first mention.

## Layout / information architecture

- **Awards are below the "Get in touch" CTA.** Page order is Work → Testimonials →
  *Get in touch* → **then** Fulbright / Geospatial Rising Star / 3× keynote / community
  builder → footer. You ask for the meeting *before* showing the credentials that earn
  it. Move the **Recognition block above the Connect section.**
- **Two "Get in touch" CTAs, and the Connect section's headline is just your name again**
  (3rd time your name is a heading). Give that section a real headline —
  e.g. *"Let's figure out what's actually broken"* — instead of repeating your name.
- **Hero is blank for ~1s on load.** The fade-in stagger (delays up to 0.5s + 0.7s
  transition) applies to the *hero itself* — first paint is an empty cream screen. Make
  the hero visible immediately; only animate below-the-fold sections.

## Technical / SEO / distribution

- **No Open Graph tags.** Only a `meta description` exists. Your distribution is
  LinkedIn — pasting the URL there shows a naked link with no preview card. Add
  `og:title`, `og:description`, `og:image` (headshot or branded card). Highest ROI after
  the HTTPS fix.
- **No favicon.** Tab shows a blank default. Add a monogram "J" in forest green (`#376E5A`).
- **`<title>` is just "Juliana McMillan-Wilhoit."** Make it work for search:
  *"Juliana McMillan-Wilhoit — Product Leader · AI, Geospatial & Public Health."*
- **Mobile nav will crowd/overflow.** 7 items (Home / Work / How I Think / About / Tools
  / Contact / Resume) in a fixed 58px bar with **no hamburger** — the CSS only shrinks
  font/gap under 720px. On a ~390px phone, name + 7 items won't fit cleanly. Add a
  hamburger/collapse under ~720px. (Verify on an actual phone.)
- **Tabler icons load from `@latest`** on a CDN. Pin a version (e.g. `@3.x`) so an
  upstream release can't silently break your icons.

## Nitpicks (only if bored)

- The domain-keyword pill strip (Public Health AI, Geospatial, etc.) floats with no
  label — reads a touch like SEO stuffing. A tiny "Focus areas" label grounds it.
- The ENSITE card's giant faint background metric is **"DA"** — letters among numeric
  ghosts (`5m`, `10×`, `180+`). Looks like a glitch.
- On desktop the H1 wraps `processes` onto its own orphan line — tighten `max-width` so
  it breaks more gracefully.

---

## TL;DR

The design is legitimately good and shippable. But it's serving a browser security
warning to every https visitor, the best reference is three-fifths of the testimonials,
the awards hide below the CTA, and there's no social preview card for someone whose
distribution is LinkedIn. **Fix the cert first — the rest is an afternoon.**

Everything except the HTTPS cert can be edited directly in this `docs/` folder (OG tags,
favicon, title, testimonial swap, section reorder, hero-fade). The cert is a click-through
in GitHub repo settings.
