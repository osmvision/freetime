## What it does

<!-- For the person using freetime: what changes for them, and why. Link the issue or discussion. -->

## How I checked it

<!-- The tests you ran, and what you tried by hand. A screenshot or two if the UI changed. -->

## Checklist

- [ ] Tests added or updated, and they pass (`cargo test -p freetime-core`, `supabase/tests`, `e2e` as relevant)
- [ ] New UI text has its French in `desktop/ui/js/i18n-fr.js`
- [ ] Works with the keyboard, has labels, and respects reduced motion
- [ ] Follows DESIGN.md (no emoji or unicode symbols as icons, red only for the main action)
- [ ] Nothing new is read or sent without the privacy policy saying so
- [ ] Game rules changed? `node desktop/scripts/sync-game-rules.mjs` was run
- [ ] Database changed? A new migration with row-level security, and a test
