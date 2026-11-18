---
version: 1
slug: "desktop-ui-index-html"
primary_target: "desktop/ui/index.html"
related_targets: ["desktop/ui/js/discover.js","desktop/ui/styles.css"]
---

# Discover (desktop app)

Scope: the desktop app shell and its Discover, History and Settings screens. Mode: Operate.
Audience and job: anyone with free time who wants one good answer in seconds (see PRODUCT.md).
Constraints: no emoji anywhere in the UI; drawn icons only; bundled fonts and photos (strict CSP);
the ranking stays in the Rust core.

## Direction contract

THESIS: Your free time is a ticket. One coupon to use now, the rest of the book behind it, every state stamped on paper. It refuses the dark game-launcher grid of same-size cards.

OWN-WORLD: Carrier navy #0D1B3D owns the rail and coupon heads; coupon white tickets on stock-white #F2F2F0; jet red #D7262D only for the primary action and the VOID stamp; carbon purple #4B2E83 for every figure (durations, prices, temperatures); carbon-copy lavender stubs. Condensed airline grotesk caps for heads and labels, a plain grotesk body, carbon typewriter numerals. Hairline-ruled fare boxes, dashed perforations, punched notches, one drawn icon family.

STORY: The visitor sees today's ticket (the best pick) with a real photo, reads why from its fare boxes (duration against their free time, fare, weather, energy), then presses Start, which validates the coupon, or Not this one, which voids it and slides the next coupon in.

FIRST VIEWPORT: Navy rail on the left (wordmark, nav, a wallet stub with the weather tag and sync state). Main: a condensed headline with the free time, the context selects in one row, then the coupon at full width: photo stub on the right behind a perforation, title, fare boxes, Start in jet red. Below, the next coupons in a row with photos.

FORM: dealt challenger vernacular-ephemera-jet-age-ticket-wallet, chosen by the user over the assigned direction (my grounded list position 6, screenprint travel posters); seed: 5d651fa7c8bf2e99. Signature interaction: the VOID and VALIDATED stamps pressing onto the coupon, and the voided coupon tearing off along its perforation. Motion grammar: one tear, one stamp press; reduced motion swaps both for an instant state change.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
