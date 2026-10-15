import { spawnSync } from 'node:child_process';
for(const name of ['carpool','api','auth','push','locations','verification']) {
 const result=spawnSync(process.execPath,[`scripts/test-${name}.mjs`],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status||1);
}
