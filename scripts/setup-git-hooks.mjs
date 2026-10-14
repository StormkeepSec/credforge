// Points git at the repo's .githooks directory. No-op outside a git checkout (e.g. Docker builds).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  } catch {
    // git not on PATH; hooks are optional.
  }
}
