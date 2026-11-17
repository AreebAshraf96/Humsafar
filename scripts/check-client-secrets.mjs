import {readdirSync,readFileSync,statSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const directory=resolve(import.meta.dirname,'../dist/client');
if(!existsSync(directory))throw new Error('Run npm run build before checking browser assets.');
const secrets=['SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SECRET_KEY','DRIVER_VERIFICATION_MODEL_KEY'].map(name=>({name,value:process.env[name]})).filter(item=>item.value);
let files=0;
function scan(directory){for(const name of readdirSync(directory)){const path=resolve(directory,name);if(statSync(path).isDirectory())scan(path);else if(/\.(?:js|mjs|json|html|css|map)$/.test(name)){files++;const text=readFileSync(path,'utf8');for(const secret of secrets)if(text.includes(secret.value))throw new Error(`Server-only ${secret.name} found in browser output`);}}}
scan(directory);console.log(`Browser secret check passed: ${files} built assets contain no configured server/model key.`);
