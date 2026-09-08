import { rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';

for (const dir of ['keys', 'data']) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[reset] Removed ${dir}/`);
  } else {
    console.log(`[reset] ${dir}/ did not exist, skipping`);
  }
}

console.log('[reset] Generating fresh validator keys...');
execSync('npm run generate-keys', { stdio: 'inherit' });
console.log('[reset] Done.');