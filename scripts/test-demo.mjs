import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['scripts/demo.mjs','--check-seed'],{encoding:'utf8',timeout:60000,env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:'https://example.invalid',NEXT_PUBLIC_SUPABASE_ANON_KEY:'demo-test-placeholder'}});
assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Demo seed passed/);
console.log('Demo startup seed passed with isolated database and no live service requests.');
