// Runs before `npm run deploy`. Wrangler uploads every file in site/,
// tracked by git or not, so refuse to deploy unless site/ holds exactly
// what's committed. That way an original photo dropped in by mistake (or
// anything git-ignored) can't go public.
import { execFileSync } from 'node:child_process';

const dirty = execFileSync('git', ['status', '--porcelain', '--ignored', '--', 'site'], { encoding: 'utf8' }).trim();
if (dirty) {
  console.error('Refusing to deploy: site/ has files that are not committed (or are git-ignored):');
  console.error(dirty);
  process.exit(1);
}
console.log('site/ matches git: ok');
