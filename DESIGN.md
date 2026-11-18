---
name: freetime
description: The ticket wallet. Your free time is a ticket; one coupon to use now, the rest of the book behind it.
colors:
  carrier-navy: "#0d1b3d"
  navy-hover: "#162a55"
  navy-active: "#24396b"
  jet-red: "#d7262d"
  jet-red-press: "#b51d23"
  carbon-purple: "#4b2e83"
  carbon-lavender: "#e6dff1"
  lavender-line: "#c6b8e0"
  stock-white: "#f2f2f0"
  coupon-white: "#ffffff"
  ink: "#0d1b3d"
  ink-2: "#3b4866"
  ink-3: "#5b6782"
  on-navy: "#f4f1ea"
  on-navy-2: "#b9c1d6"
  good: "#1f6b4a"
typography:
  display:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "54px"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.005em"
  coupon-title:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "48px"
    fontWeight: 800
    lineHeight: 0.98
  label:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.12em"
  body:
    fontFamily: "Barlow, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  figures:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "17px"
    fontWeight: 700
rounded:
  fare: "4px"
  control: "6px"
  tag: "8px"
  ticket: "10px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "18px"
  lg: "26px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.jet-red}"
    textColor: "{colors.coupon-white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "46px"
    padding: "0 20px"
  button-primary-hover:
    backgroundColor: "{colors.jet-red-press}"
  button-secondary:
    backgroundColor: "{colors.coupon-white}"
    textColor: "{colors.carrier-navy}"
    rounded: "{rounded.control}"
    height: "46px"
  button-secondary-hover:
    backgroundColor: "{colors.carrier-navy}"
    textColor: "{colors.coupon-white}"
  coupon:
    backgroundColor: "{colors.coupon-white}"
    rounded: "{rounded.ticket}"
  coupon-head:
    backgroundColor: "{colors.carrier-navy}"
    textColor: "{colors.on-navy}"
  coupon-stub:
    backgroundColor: "{colors.carbon-lavender}"
  rail:
    backgroundColor: "{colors.carrier-navy}"
    textColor: "{colors.on-navy-2}"
    width: "248px"
  rail-tag:
    backgroundColor: "{colors.carbon-lavender}"
    textColor: "{colors.carrier-navy}"
    rounded: "{rounded.tag}"
---

# Design System: freetime

## Overview

freetime answers one question in seconds: what should I do with the free time I have right now? The interface treats that answer as a **ticket**. The best pick is issued as a full-width coupon with a real photo on its stub; the other picks are the rest of the book behind it. Every state is stamped on paper: Start presses VALIDATED onto the coupon, "Not this one" presses VOID and tears it off along the perforation.

The world is the jet-age airline ticket wallet: carrier navy, coupon white on stock white, jet red reserved for the one action, carbon purple for every figure. It refuses the dark game-launcher grid of same-size cards. The mode is Operate: the world lends type, palette, density and one signature move; controls and navigation stay standard.

## Colors

### Primary
- **Carrier navy `#0d1b3d`** owns the rail, the coupon heads, the photo-tag chips, toasts, and all body ink.
- **Jet red `#d7262d`** appears only on the primary action (Start, Save changes) and the VOID stamp. Nothing decorative is red.

### Secondary
- **Carbon purple `#4b2e83`** is the color of figures: durations, fares, temperatures, counts, the VALIDATED stamp, the time bar.
- **Carbon lavender `#e6dff1`** is carbon-copy paper: coupon stubs, rail tags, strips (city prompt, "how was it?"), pressed toggles.

### Neutral
- **Stock white `#f2f2f0`** is the page. **Coupon white `#ffffff`** is every ticket, panel and input.
- Ink steps `#0d1b3d` / `#3b4866` / `#5b6782` for title, body and labels (all AA on coupon and stock white).

### Named Rules
- **One red.** If a second red thing appears on a screen, one of them is wrong.
- **Figures are purple.** Any number the user reads to decide goes in Courier Prime, carbon purple.

## Typography

- **Barlow Condensed** (500 to 800), uppercase, for headlines, coupon titles, nav, buttons and tab-cap labels. Labels track out to 0.10 to 0.14em.
- **Barlow** (400 to 700) for body and details.
- **Courier Prime** (400, 700) for carbon typewriter numerals: fare boxes, ticket date, stats, rail tag values.
- All three are bundled as woff2 in `desktop/ui/fonts` (strict CSP, works offline).

### Hierarchy
Page title 54px/800 → coupon title 48px/800 → section title 28px/800 → leaf title 22px/700 → body 16px → labels 12 to 13px caps.

## Layout

- Desktop: a 248px navy rail, then a centered column of max 1180px with 44px side padding.
- Discover: headline with the free time ("Your 1h30 tonight") and the two re-draw buttons on its right; the context selects in one row; the coupon full width (main part, dashed perforation, 360px photo stub); then the book as a grid of `minmax(250px, 1fr)` leaves.
- Under 1100px the stub narrows to 280px. Under 860px the rail becomes a bottom tab bar, the stub moves on top of the coupon, the selects scroll sideways, and fare boxes go 2×2.

## Elevation & Depth

Paper on a desk, not glass. One shadow: `0 1px 1px rgba(13,27,61,.06), 0 8px 24px -10px rgba(13,27,61,.28)` on coupons, leaves, panels, menus and toasts. Borders are hairlines (`1px` ruled fare boxes) or dashed perforations (`2px dashed`). No glows, no blur.

## Shapes

- Tickets 10px, rail tags 8px, controls 6px, fare boxes and chips 4px.
- **Punched notches:** stock-white circles cut into the perforation line of the coupon (22px) and of each leaf (16px), and one on the left edge of each rail tag.

## Components

### Buttons
Caps Barlow Condensed 17px, 46px tall (38px small). Primary is jet red. Secondary is outlined navy (1.5px) and fills navy on hover. Quiet is borderless. Icon-only buttons are 46/38px square with an aria-label.

### Context selects
A labelled button (icon, caps name, value, chevron) opening a small menu; options are 44px rows with `aria-pressed` and a check. "Mood" is multi-select with a Done button. Any change re-ranks after 220ms.

### Coupon (signature)
Navy head ("Admit one · Sport" and the ticket date in figures), title, detail, four hairline fare boxes (Duration, Fare, Weather, Energy), the time bar (solid = at least, hatched = up to, navy tick = your free time), the reasons with checks, then Start / open link / Not this one. Stub: photo, "From" source, photo credit.

### Leaves
Photo with a navy category chip, perforation with notches, title, two-line detail, figures, then Start (outlined), open-link square and a void square.

### Rail tags
Lavender baggage tags at the foot of the rail: the weather (Lucide sky icon, place, temperature and sky) and sync state (refresh action).

### Stamps
VOID (jet red) and VALIDATED (carbon purple), 5px border, rotated -11°, pressed in from 1.7× in 320ms. Reduced motion: instant.

## Do's and Don'ts

### Do:
- **Do** use one Lucide icon family (`desktop/ui/js/icons.js`, generated by `scripts/vendor-assets.mjs`) for every glyph.
- **Do** give built-in ideas a bundled photo (`scripts/fetch_photos.py`) and credit it in Settings.
- **Do** keep 44px minimum hit targets and a visible 2px focus ring.

### Don't:
- **Don't** use emoji or unicode symbols as icons, anywhere.
- **Don't** use red for anything but the primary action and VOID.
- **Don't** use eyebrow/kicker labels above headings, gradient text, or side stripes wider than 1px.
- **Don't** fall back to a grid of identical dark cards; the best pick is always the full-width coupon.
