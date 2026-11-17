import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const python = resolve(root, 'work/verification-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const mode = process.argv[2] || 'start';
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (mode === 'setup') {
  mkdirSync(resolve(root, 'work'), { recursive: true });
  if (!existsSync(python)) run(process.env.HUMSAFAR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'venv', resolve(root, 'work/verification-venv')]);
  run(python, ['-m', 'pip', 'install', '-r', 'verification-model/requirements-test.txt']);
  run(python, ['verification-model/download_models.py', '--test-fixtures']);
  const path = resolve(root, '.env.local');
  let env = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const [name, value] of Object.entries({ DRIVER_VERIFICATION_MODEL_URL: 'http://127.0.0.1:8000/verify', DRIVER_VERIFICATION_MODEL_KEY: randomBytes(48).toString('base64url'), DRIVER_VERIFICATION_FACE_MIN_SCORE: '0.383' })) {
    if (!new RegExp(`^${name}=.+`, 'm').test(env)) env = env.replace(new RegExp(`^${name}=.*(?:\r?\n|$)`, 'm'), '') + `\n${name}=${value}\n`;
  }
  writeFileSync(path, env);
  console.log('Local verification service ready. Secrets are stored only in ignored .env.local.');
} else {
  if (!existsSync(python)) throw new Error('Run npm run verification:setup first.');
  if (mode === 'test') run(python, ['-m', 'pytest', 'verification-model/tests', '-q', ...process.argv.slice(3)]);
  else if (mode === 'start') run(python, ['-m', 'uvicorn', 'app:app', '--app-dir', 'verification-model', '--host', '127.0.0.1', '--port', '8000', '--env-file', '.env.local']);
  else throw new Error('Expected setup, test or start.');
}
