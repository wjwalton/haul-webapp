// npm run laptop: build a self-contained copy for a laptop in laptop/ (git-ignored). One folder for
// Windows and Linux:
//   laptop/app/                 the built app (with the two firmware images if src/assets/firmware has them)
//   laptop/Start Shop Tool.cmd  Windows, double-click: serves app/ on http://localhost:8173 (serve.ps1)
//   laptop/start-shop-tool.sh   Linux, `sh start-shop-tool.sh`: the same with Python 3 (serve.py)
//   laptop/README.txt
// The simulated bike (developer tools) is included, so the screens can be tried before connecting a bike.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'laptop');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [vite, 'build', '--outDir', join(out, 'app'), '--emptyOutDir'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_TOOLS: '1' },
});

// Line endings are set here whatever the checkout did: cmd.exe and PowerShell get CRLF, Linux gets LF
// (a CRLF shell script fails there). The README gets CRLF so Notepad shows it right; Linux editors cope.
const src = join(root, 'tools', 'laptop');
const copy = (name, eol, mode) => {
  const text = readFileSync(join(src, name), 'utf8').replace(/\r?\n/g, eol);
  writeFileSync(join(out, name), text);
  if (mode) chmodSync(join(out, name), mode); // kept by tar / rsync; a FAT USB stick drops it (use `sh …`)
};
copy('Start Shop Tool.cmd', '\r\n');
copy('serve.ps1', '\r\n');
copy('README.txt', '\r\n');
copy('start-shop-tool.sh', '\n', 0o755);
copy('serve.py', '\n', 0o755);

const assets = existsSync(join(out, 'app', 'assets')) ? readdirSync(join(out, 'app', 'assets')) : [];
const firmware = assets.filter((f) => /\.(bin|zip)$/i.test(f));
console.log(`\nLaptop copy ready: ${out}`);
console.log(firmware.length
  ? `Built-in firmware: ${firmware.join(', ')} (keep this folder private)`
  : 'No built-in firmware (src/assets/firmware is empty): the update screen will ask for the file.');
