// Additive, fail-closed integration installer for Prevention Operations.
// Run from project root: node scripts/install-prevention-ops.mjs
// It never reads or changes credentials, Reddit HTML code, Shield logic, or stealth/gate.js.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pathFor = relative => path.join(root,relative);
const staged=new Map();
function replace(relative, anchor, addition, position='before', marker=addition.trim().split('\n')[0].trim()) {
  const f=pathFor(relative);
  if(!fs.existsSync(f))throw Error(`Required file is missing: ${relative}`);
  const initial=staged.get(relative)?.original ?? fs.readFileSync(f,'utf8');
  const current=staged.get(relative)?.updated ?? initial;
  if(current.includes(marker)){console.log(`Already integrated: ${relative} (${marker.slice(0,45)})`);return;}
  const loc=current.indexOf(anchor);
  if(loc<0 || current.indexOf(anchor,loc+1)>=0)throw Error(`Cannot find a unique integration anchor in ${relative}: ${anchor.slice(0,80)}`);
  const updated=position==='after'?current.slice(0,loc+anchor.length)+addition+current.slice(loc+anchor.length)
    :current.slice(0,loc)+addition+current.slice(loc);
  staged.set(relative,{relative,f,original:initial,updated});
}
function substitute(relative,before,after) {
  const f=pathFor(relative);
  if(!fs.existsSync(f))throw Error(`Required file is missing: ${relative}`);
  const initial=staged.get(relative)?.original ?? fs.readFileSync(f,'utf8');
  const current=staged.get(relative)?.updated ?? initial;
  if(current.includes(after))return;
  if(current.indexOf(before)<0 || current.indexOf(before)!==current.lastIndexOf(before))throw Error(`Cannot uniquely replace ${before} in ${relative}`);
  staged.set(relative,{relative,f,original:initial,updated:current.replace(before,after)});
}

try {
  replace('server/src/app.js',"import { registerShieldRoutes } from './shield/routes.js';",
    "\nimport { registerPreventionOperationsRoutes } from './prevention/routes.js';",'after','registerPreventionOperationsRoutes }');
  replace('server/src/app.js','  registerShieldRoutes(app,{repo,reddit});',
    "\n  registerPreventionOperationsRoutes(app,{repo});",'after','  registerPreventionOperationsRoutes(app,{repo});');
  replace('server/src/db.js','    async insertAlert(alert) {',`    // Prevention Operations: server-only, operator-controlled review queue.
    async listPreventionReviews(accountId) {
      return unwrap(await db.from('prevention_review_queue').select('*').eq('account_id',accountId)
        .order('created_at',{ascending:false}).limit(200),'list prevention reviews');
    },
    async getPreventionReview(id) {
      return unwrap(await db.from('prevention_review_queue').select('*').eq('id',id).maybeSingle(),'load prevention review');
    },
    async createPreventionReview(fields) {
      return unwrap(await db.from('prevention_review_queue').insert(fields).select().single(),'create prevention review');
    },
    async finishPreventionReview(id,state,reason) {
      return unwrap(await db.from('prevention_review_queue').update({state,completion_reason:reason,
        completed_at:new Date().toISOString(),updated_at:new Date().toISOString()})
        .eq('id',id).eq('state','held').select().single(),'complete prevention review');
    },
    async clearPreventionReviews(accountId) {
      unwrap(await db.from('prevention_review_queue').delete().eq('account_id',accountId),'clear prevention reviews');
    },

`,'before','async listPreventionReviews(accountId)');
  replace('server/test/helpers.js','  const votes = new Map();',
    '  const preventionReviews=new Map();\n','before','const preventionReviews=new Map()');
  replace('server/test/helpers.js','    async ping() {',`    // Mirror of db.js prevention_review_queue methods.
    preventionReviews,
    async listPreventionReviews(accountId) {return [...preventionReviews.values()].filter(r=>r.account_id===accountId).sort(newestFirst('created_at'));},
    async getPreventionReview(id) {return preventionReviews.get(id)??null;},
    async createPreventionReview(fields) {const row={...fields,id:randomUUID(),created_at:iso(),updated_at:iso(),completed_at:null,completion_reason:null};preventionReviews.set(row.id,row);return {...row};},
    async finishPreventionReview(id,state,reason) {const previous=preventionReviews.get(id);if(!previous||previous.state!=='held')throw new Error('Review no longer held.');const row={...previous,state,completion_reason:reason,completed_at:iso(),updated_at:iso()};preventionReviews.set(id,row);return {...row};},
    async clearPreventionReviews(accountId) {for(const [id,row] of preventionReviews)if(row.account_id===accountId)preventionReviews.delete(id);},
`,'before','async listPreventionReviews(accountId)');
  replace('server/test/helpers.js','      preventionProfiles.delete(id);',
    '\n      for(const [reviewId,review] of preventionReviews)if(review.account_id===id)preventionReviews.delete(reviewId);','after',
    'for(const [reviewId,review] of preventionReviews)');
  replace('client/src/lib/api.js',"  shieldOverview: () => request('/shield/overview'),",`  preventionOverview: () => request('/prevention/overview'),
  preventionDetail: accountId => request(\`/accounts/\${id(accountId)}/prevention\`),
  preventionVoteSources: accountId => request(\`/accounts/\${id(accountId)}/prevention/vote-sources\`),
  preventionHold: (accountId,reason) => request(\`/accounts/\${id(accountId)}/prevention/reviews\`,{method:'POST',body:{reason}}),
  preventionComplete: (accountId,reviewId,action,reason) => request(\`/accounts/\${id(accountId)}/prevention/reviews/\${id(reviewId)}/\${action}\`,{method:'POST',body:{reason}}),
`.replaceAll('\u001b`','`'),'before','preventionOverview:');
  replace('client/src/App.jsx',"import Preventer from './components/Preventer.jsx';",
    "\nimport PreventionOps from './components/PreventionOps.jsx';",'after','import PreventionOps from');
  replace('client/src/App.jsx',"preventer:['Preventer','Account readiness, activity risk and pre-post checks'],",
    "prevention:['Prevention Operations','Review queue, health trends and voting data sources'],",'after',"prevention:['Prevention Operations'");
  replace('client/src/App.jsx',"['preventer','shield','Preventer'],",
    "['prevention','activity','Prevention Operations'],",'after',"['prevention','activity'");
  replace('client/src/App.jsx',"{route==='preventer'&&<Preventer accounts={accounts} demo={demo}/>}",
    "{route==='prevention'&&<PreventionOps accounts={accounts} demo={demo}/>}",'after',"{route==='prevention'&&");
  substitute('client/src/App.jsx',"'quick-check','preventer','shield','settings'", "'quick-check','preventer','prevention','shield','settings'");
  // CSS appended once to inherit both theme palettes.
  const cssPath=pathFor('client/src/styles.css');
  const css=fs.readFileSync(cssPath,'utf8');
  if(!css.includes('/* Prevention Operations —')) {
    const companionCss=fs.readFileSync(pathFor('scripts/prevention-ops.css'),'utf8');
    staged.set('client/src/styles.css',{relative:'client/src/styles.css',f:cssPath,original:css,updated:css+'\n'+companionCss});
  }
  const missing=['server/src/prevention/ops.js','server/src/prevention/routes.js','server/test/preventionOps.test.js','client/src/components/PreventionOps.jsx','supabase/prevention_ops.sql'].filter(p=>!fs.existsSync(pathFor(p)));
  if(missing.length)throw Error('Required new files missing: '+missing.join(', '));
  const patches=[...staged.values()];
  if(process.argv.includes('--check')) {console.log(`Validated ${patches.length} integrations; no files changed.`);process.exit(0);}
  if(!patches.length){console.log('Prevention Operations already integrated.');process.exit(0);}
  const backupDir=pathFor('.prevention-ops-backup/'+new Date().toISOString().replaceAll(':','-'));
  for(const p of patches){const dest=path.join(backupDir,p.relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,p.original);}
  for(const p of patches){fs.writeFileSync(p.f,p.updated);console.log('Updated '+p.relative);}
  console.log('Original files backed up in '+backupDir);
  console.log('Next: run supabase/prevention_ops.sql, npm test, and npm run build.');
}catch(err){console.error('No files changed: '+err.message);process.exitCode=1;}
