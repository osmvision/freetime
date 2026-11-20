-- Chess joins the two-player games. The rules run in the games Edge Function (rules.js), like the
-- others; the database only needs to know the game's name. The state (a board, the castling rights,
-- the positions seen since the last capture or pawn move) stays far under the 16000-byte limit.
alter table public.matches drop constraint matches_game_check;
alter table public.matches
  add constraint matches_game_check check (game in ('four', 'gomoku', 'draughts', 'dots', 'torpedoes', 'chess'));
