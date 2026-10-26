// Add Account Shield to the CURRENT local Reddit project without replacing
// existing files (including recent Claude fixes to Reddit scraping).
// Run from reddit-monitor/: node scripts/install-shield.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
const piece=JSON.parse(fs.readFileSync(path.join(here,'shield-snippets.json'),'utf8'));
const input={};
const set=(file,transform)=>{
  const src=fs.readFileSync(path.join(root,file),'utf8');
  input[file]=transform(src,file);
};
function inject(src,needle,insert,marker,file,{before=false}={}) {
  if(src.includes(marker))return src;
  if(!src.includes(needle))throw Error(`Could not locate integration point in ${file}: ${needle.slice(0,65)}`);
  return src.replace(needle,before?insert+needle:needle+insert);
}

set('server/src/db.js',(src,file)=>inject(src,'    async insertAlert(alert) {',piece.db_methods,'// Account Shield: persistent draft queue',file,{before:true}));
set('server/src/app.js',(src,file)=>{
  src=inject(src,"import { analyzeActivity, assessReadiness, scanDraft } from './preventer/engine.js';","\nimport { registerShieldRoutes } from './shield/routes.js';",'import { registerShieldRoutes }',file);
  return inject(src,'  // Preventer: internal, read-only activity & draft checks.',"  registerShieldRoutes(app,{repo,reddit});\n\n",'  registerShieldRoutes(app,{repo,reddit});',file,{before:true});
});
set('server/src/checker.js',(src,file)=>{
  if(!src.includes("import { interventionFor } from './shield/policy.js';"))src="import { interventionFor } from './shield/policy.js';\n"+src;
  return inject(src,'    return { account: updated, check, alerts };',piece.checker_block,'// Shield circuit breaker:',file,{before:true});
});
set('server/test/helpers.js',(src,file)=>{
  src=inject(src,'  const preventionProfiles = new Map();',"\n  const shieldDrafts=new Map(),shieldHolds=new Map(),shieldEvents=[],shieldOutcomes=[],shieldIncidents=new Map();",'const shieldDrafts=new Map()',file);
  return inject(src,'    async ping() {',piece.helper_methods,'    shieldDrafts,shieldHolds,shieldEvents,shieldOutcomes,shieldIncidents,',file,{before:true});
});
set('client/src/lib/api.js',(src,file)=>inject(src,"  preventerScan: (draft) => request('/preventer/preflight',{method:'POST',body:draft}),",'\n'+piece.api_methods.trimEnd(),'  shieldOverview: () => request',file));
set('client/src/App.jsx',(src,file)=>{
  src=inject(src,"import Preventer from './components/Preventer.jsx';","\nimport Shield from './components/Shield.jsx';",'import Shield from',file);
  src=inject(src,"preventer:['Preventer','Account readiness, activity risk and pre-post checks']",",shield:['Account Shield','Managed draft firewall and safety holds']", "shield:['Account Shield'",file);
  src=inject(src,"['preventer','shield','Preventer']",",['shield','lock','Account Shield']","['shield','lock','Account Shield']",file);
  src=inject(src,"{route==='preventer'&&<Preventer accounts={accounts} demo={demo}/>}","{route==='shield'&&<Shield accounts={accounts} demo={demo}/>}","{route==='shield'&&<Shield",file);
  if(!src.includes("'preventer','shield','settings'].includes(route)")){
    const needle="'preventer','settings'].includes(route)";
    if(!src.includes(needle))throw Error(`Could not locate page allowlist in ${file}`);
    src=src.replace(needle,"'preventer','shield','settings'].includes(route)");
  }
  return src;
});
set('client/src/styles.css',(src)=>src.includes('/* Account Shield —')?src:src+'\n'+piece.css);

const changed=Object.entries(input).filter(([file,value])=>fs.readFileSync(path.join(root,file),'utf8')!==value);
if(!changed.length){console.log('Shield integration already installed. No files changed.');process.exit(0);}
const backupDir=path.join(root,'.shield-install-backup',new Date().toISOString().replace(/[:.]/g,'-'));
// All integration points were checked before ANY existing file is touched.
for(const [file] of changed){const target=path.join(backupDir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,file),target);}
try {
  for(const [file,value] of changed){fs.writeFileSync(path.join(root,file),value);console.log('Updated:',file);}
  console.log(`Backups saved to: ${backupDir}`);
  console.log('Next: run supabase/shield.sql in Supabase SQL Editor, then npm test and npm run build.');
} catch(err) {
  for(const [file] of changed)fs.copyFileSync(path.join(backupDir,file),path.join(root,file));
  throw err;
}
