// Copies the game rules from the app to the games Edge Function, which checks online moves with
// exactly the same code. Run after editing desktop/ui/js/play/rules.js:
//   node desktop/scripts/sync-game-rules.mjs
// (a test in supabase/tests/games.test.mjs fails while the two differ).
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
copyFileSync(join(root, 'desktop', 'ui', 'js', 'play', 'rules.js'), join(root, 'supabase', 'functions', 'games', 'rules.js'));
console.log('rules copied to supabase/functions/games/rules.js');
