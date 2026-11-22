# Accessibility

freetime is meant for anyone with a bit of free time, so it should work for everyone. This page
says what we aim for, what already works, what doesn't yet, and how to tell us about a barrier.

## Our commitment

We aim for [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA. In practice:

- Text contrast of at least 4.5:1 (3:1 for large text), in both the day and night themes.
- Everything works with a keyboard, with a visible focus.
- Buttons and targets at least 44 px, so they are easy to hit with a finger or a shaky hand.
- Nothing relies on colour alone (one exception for now, see below).
- Motion is never needed, and stops when your system asks for reduced motion.
- No emoji or symbols standing in for words; drawn icons always come with a text or a label.

## What already works

- **Text size**: Normal, Large, Extra large or Huge, in Settings.
- **Themes**: Day, Night, or like Windows, and a **High contrast** mode.
- **Reduced motion**: animations (the game moves, the photo zoom in Guess the activity, the
  stamps) are turned off when your system asks for reduced motion.
- **Keyboard**: Alt+1 to Alt+5 switch screens and Alt+Q opens Games. On Discover, S starts the
  idea, N passes it, O shows other picks, R draws a surprise. Escape closes windows. Game boards
  are played with Tab and Enter; the puzzles of the day with the arrow keys, Enter and Space.
- **Screen readers**: game squares, pieces and puzzle cells have names ("e4, white pawn",
  "Row 2, column 3, zone 4, star"), the "your turn" status is announced, and photos that only decorate
  are hidden from them.
- **Sounds** are off until you switch them on, and nothing is said only by a sound.
- **Two languages**: English and French.

## Known limitations

- **Colour alone**: in Four in a row, Reversi and Draughts, the two players' pieces differ only by
  colour (red and purple). Crosses and circles tell the players apart in the tic-tac-toe games,
  but these three have no shape difference yet.
- **Guess the activity** is a visual game: the photos can't have a description without giving the
  answer away.
- **Board games on a phone**: on a small screen, the squares of Giant tic-tac-toe (15 × 15
  especially), Draughts and Chess are smaller than 44 px.
- **Live games** run on a clock; there is no extra time option yet. Turn-by-turn games have no
  clock.
- **Screen readers** have only been checked lightly. Following a whole game of chess or awalé
  with a screen reader is possible but slow.
- **Photos and Steam / YouTube artwork** come without a description.

## Supported environments

- The **desktop app** on Windows 10 and 11 (it uses Microsoft Edge WebView2), with a keyboard, a
  mouse or touch.
- The **web version** in current browsers, on computers and phones. Our automatic tests run in
  Chromium only, so tell us if something breaks in another browser.

## Report a barrier

If something in freetime is hard or impossible for you to use, we want to know:

- **[Open an accessibility issue](https://github.com/osmvision/freetime/issues/new?template=accessibility.yml)**
  on GitHub, or
- in the app, **Settings → Report a problem**: it works without an account, and you can attach a
  screenshot.

Tell us what you were trying to do, what got in the way, and what you use (screen reader, zoom,
keyboard only, switch access...). We treat barriers as bugs.
