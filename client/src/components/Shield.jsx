import React,{useCallback,useEffect,useState} from 'react';
import Icon from './Icon.jsx';
import DetectionLab from './DetectionLab.jsx';
import {api} from '../lib/api.js';

const blank={accountId:'',subreddit:'',kind:'post',title:'',text:'',url:'',rulesText:''};
const labels={approved:'Approved',review:'Review',held:'Held',cancelled:'Cancelled',published:'Recorded published'};
const time=v=>v?new Date(v).toLocaleString():'—';
const S=({state})=><span className={`shield-state shield-state-${state}`}>{labels[state]||state}</span>;

export default function Shield({accounts=[],demo=false}) {
  const [tab,setTab]=useState('overview');
  const [data,setData]=useState({drafts:[],holds:[],events:[],incidents:[]});
  const [collisions,setCollisions]=useState([]);
  const [incident,setIncident]=useState({accountId:'',summary:'',notes:''});
  const [draft,setDraft]=useState(blank);
  const [holdAccount,setHoldAccount]=useState('');
  const [holdReason,setHoldReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [message,setMessage]=useState('');
  const [health,setHealth]=useState(null);
  const [error,setError]=useState('');
  const refresh=useCallback(async()=>{
    if(demo){setLoading(false);return;}
    try{setData(await api.shieldOverview());setError('');}
    catch(e){setError(e.message);}finally{setLoading(false);}
  },[demo]);
  useEffect(()=>{refresh();const timer=setInterval(refresh,30000);return()=>clearInterval(timer);},[refresh]);
  useEffect(()=>{if(tab==='collisions'&&!demo)api.shieldCollisions().then(d=>setCollisions(d.collisions||[])).catch(e=>setError(e.message));},[tab,demo,data.drafts]);
  useEffect(()=>{if(!incident.accountId&&accounts[0])setIncident(i=>({...i,accountId:accounts[0].id}));},[accounts,incident.accountId]);
  useEffect(()=>{if(!draft.accountId&&accounts[0])setDraft(d=>({...d,accountId:accounts[0].id}));if(!holdAccount&&accounts[0])setHoldAccount(accounts[0].id);},[accounts,draft.accountId,holdAccount]);
  const op=async(fn,success)=>{setBusy(true);setError('');setMessage('');try{await fn();setMessage(success);await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const createDraft=e=>{e.preventDefault();op(async()=>{await api.shieldCreateDraft(draft);setDraft(d=>({...blank,accountId:d.accountId}));},'Draft reviewed and saved to the managed queue.');};
  const promptAction=(d,action)=>{
    let reason='';let permalink='';
    if(['approve','hold','cancel'].includes(action)) {reason=window.prompt(`Reason to ${action} this draft (required):`,'');if(reason===null)return;}
    if(action==='mark_published'){permalink=window.prompt('Reddit permalink of the manually published submission:','');if(permalink===null)return;}
    op(()=>api.shieldDraftAction(d.id,{action,reason,permalink}),`Draft ${action.replace('_',' ')} recorded.`);
  };
  const verifyDraft=d=>op(()=>api.shieldVerifyDraft(d.id),'Public listing check saved. An absent item is marked unknown, not removed.');
  const inspectHealth=()=>op(async()=>{setHealth(await api.status());},'Connection status refreshed.');
  const recordOutcome=d=>{const visibility=window.prompt('Manually observed visibility: visible, removed, or unknown','unknown');if(visibility===null)return;const note=window.prompt('Optional source/evidence note:','');if(note===null)return;op(()=>api.shieldRecordOutcome(d.id,{visibility,note}),'Manual outcome recorded in audit history.');};
  const createHold=e=>{e.preventDefault();op(async()=>{await api.shieldCreateHold({accountId:holdAccount,reason:holdReason});setHoldReason('');},'Safety hold applied. Queued drafts for the account are held.');};
  const createIncident=e=>{e.preventDefault();op(async()=>{await api.shieldCreateIncident(incident);setIncident(i=>({...i,summary:'',notes:''}));},'Incident opened.');};
  const changeIncident=(id,status)=>{const note=window.prompt('Reason / evidence for this status update (required):','');if(note===null)return;op(()=>api.shieldUpdateIncident(id,{status,note}),'Incident history updated.');};
  const releaseHold=h=>{const reason=window.prompt('Why is this hold safe to release? (required)','');if(reason===null)return;op(()=>api.shieldReleaseHold(h.id,reason),'Hold released. Drafts remain held pending individual review.');};
  const names=Object.fromEntries(accounts.map(a=>[a.id,a.username]));
  const active=data.holds.filter(h=>!h.released_at);
  const queued=data.drafts.filter(d=>['review','held','approved'].includes(d.state));
  const count=(key)=>data.drafts.filter(d=>d.state===key).length;
  const stat=(label,value,sub)=><div className="shield-tile"><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>;
  return <div className="screen flow-in shield-screen">
    <div className="shield-hero"><div className="shield-emblem"><Icon name="shield" size={26}/></div><div><p className="shield-overline">ACTIVE ACCOUNT PROTECTION</p><h2>Account Shield</h2><p>Preflight review, managed submission holds, and a traceable audit trail. Works only on submissions recorded through this workspace.</p></div><button className="shield-button shield-secondary" onClick={refresh} disabled={busy||loading}><Icon name="refresh" size={15}/> Refresh</button></div>
    {demo&&<div className="shield-warning"><Icon name="info"/> Switch to Live API mode in Settings. Shield does not write or simulate live account decisions in Demo Mode.</div>}
    {loading&&<div className="shield-message">Loading Shield data…</div>}
    {error&&<div className="shield-warning" role="alert"><Icon name="alert"/> {error}{error.includes('shield_')&&' — Run supabase/shield.sql in Supabase SQL Editor first.'}</div>}
    {message&&<div className="shield-success" role="status"><Icon name="circleCheck"/> {message}</div>}
    <div className="shield-stats">{stat('Managed drafts',data.drafts.length,'In Shield queue')}{stat('Needs review',count('review'),'Pending operator decision')}{stat('Held drafts',count('held'),'Blocked in this queue')}{stat('Active holds',active.length,'Account-level safety stops')}</div>
    <div className="shield-tabs" role="tablist" aria-label="Shield views">{[['overview','Overview'],['drafts','Submission firewall'],['holds','Safety holds'],['collisions','Overlaps'],['incidents','Incidents'],['audit','Audit & outcomes'],['lab','Research lab']].map(([id,label])=><button role="tab" aria-selected={tab===id} className={tab===id?'active':''} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    {tab==='overview'&&<div className="shield-grid-block"><section className="shield-card"><h3>Protection status</h3><p>Account checks can activate safety holds when serious restrictions, removal spikes, or critical risks are recorded. Publishing is intentionally not automated.</p><div className="shield-flow"><div>Draft entered</div><span>→</span><div>Monitor + Preventer</div><span>→</span><div>Approve / Review / Hold</div></div><div className="shield-info-row"><Icon name="shield"/> A hold blocks drafts inside Shield only. It cannot stop posts made outside this application.</div></section><section className="shield-card"><h3>Most recent decisions</h3>{data.events.length===0?<p className="shield-note">No decisions recorded yet.</p>:<ul className="shield-events">{data.events.slice(0,6).map(e=><li key={e.id}><b>{e.event_type.replaceAll('_',' ')}</b><small>{names[e.account_id]?'u/'+names[e.account_id]:'System'} · {time(e.created_at)}</small></li>)}</ul>}</section><section className="shield-card shield-wide"><h3>Connection integrity</h3><p>Inspect backend, database, and browser connectivity on demand. Monitoring and publishing stay separate.</p><button className="shield-button shield-secondary" onClick={inspectHealth} disabled={busy||demo}><Icon name="refresh" size={15}/> Check connections</button>{health&&<div className="shield-connection"><span>Database: {health.database?.ok?'Connected':'Unavailable'}</span><span>Reddit reader: {health.reddit?.ok?'Available':'Unavailable'}</span><span>Scheduler: {health.scheduler?.running?'Running':'Idle'}</span></div>}<p className="shield-note">Chrome companion lives in <code>shield-extension/</code>. Load it as an unpacked extension to see the local hold count and open this dashboard.</p></section><section className="shield-card shield-wide"><h3>Accounts under hold</h3>{!active.length?<p className="shield-note">No account-level holds currently active.</p>:active.map(h=><div key={h.id} className="shield-listrow"><div><strong>u/{names[h.account_id]||h.account_id}</strong><p>{h.reason}</p></div><S state="held"/></div>)}</section></div>}
    {tab==='drafts'&&<div className="shield-grid-block"><section className="shield-card"><h3>New submission review</h3><p>Inspect a draft before publishing. Shield will save its decision and reasons. No submission is sent to Reddit.</p><form className="shield-form" onSubmit={createDraft}>
      <label>Account<select value={draft.accountId} onChange={e=>setDraft(d=>({...d,accountId:e.target.value}))} required>{accounts.map(a=><option value={a.id} key={a.id}>u/{a.username}</option>)}</select></label>
      <div className="shield-duo"><label>Community<input required placeholder="AskReddit" value={draft.subreddit} onChange={e=>setDraft(d=>({...d,subreddit:e.target.value}))}/></label><label>Type<select value={draft.kind} onChange={e=>setDraft(d=>({...d,kind:e.target.value}))}><option value="post">Post</option><option value="comment">Comment</option></select></label></div>
      <label>Title (optional)<input maxLength={300} placeholder="A clear, relevant title" value={draft.title} onChange={e=>setDraft(d=>({...d,title:e.target.value}))}/></label>
      <label>Draft text<textarea rows={5} maxLength={10000} placeholder="Write your proposed submission here" value={draft.text} onChange={e=>setDraft(d=>({...d,text:e.target.value}))}/></label>
      <label>External link (optional)<input type="url" value={draft.url} placeholder="https://example.com" onChange={e=>setDraft(d=>({...d,url:e.target.value}))}/></label>
      <label>Community rules / relevant excerpts<textarea rows={3} value={draft.rulesText} onChange={e=>setDraft(d=>({...d,rulesText:e.target.value}))} placeholder="Paste relevant rules to improve accuracy"/></label>
      <button disabled={busy||demo||!accounts.length} className="shield-button" type="submit"><Icon name="shield" size={15}/> Review and save draft</button></form></section>
      <section className="shield-card"><h3>Managed drafts <small>({data.drafts.length})</small></h3><p>Review, hold, or manually record publication. Each action is audited.</p>{data.drafts.length===0?<div className="shield-empty">No drafts yet. Submit the form to create one.</div>:<div className="shield-draft-list">{data.drafts.map(d=><article className="shield-draft" key={d.id}><div className="shield-draft-top"><div><strong>r/{d.subreddit}</strong><small>u/{names[d.account_id]||'Account'} · {time(d.created_at)}</small></div><S state={d.state}/></div><p className="shield-draft-title">{d.title||d.body?.slice(0,150)||d.url}</p>{d.last_decision?.findings?.length>0&&<ul className="shield-finding">{d.last_decision.findings.slice(0,4).map((f,i)=><li key={i}><b>{f.title}</b> — {f.detail}</li>)}</ul>}<div className="shield-actions">
        {['review','held','approved'].includes(d.state)&&<button disabled={busy||demo} onClick={()=>promptAction(d,'recheck')}>Recheck</button>}
        {['review','held'].includes(d.state)&&<button disabled={busy||demo} onClick={()=>promptAction(d,'approve')}>Approve with reason</button>}
        {['review','approved'].includes(d.state)&&<button disabled={busy||demo} onClick={()=>promptAction(d,'hold')}>Hold</button>}
        {d.state==='approved'&&<button disabled={busy||demo} onClick={()=>promptAction(d,'mark_published')}>Record publication</button>}
        {d.state==='published'&&<><button disabled={busy||demo} onClick={()=>verifyDraft(d)}>Check public listing</button><button disabled={busy||demo} onClick={()=>recordOutcome(d)}>Record outcome manually</button></>}
        {!['published','cancelled'].includes(d.state)&&<button disabled={busy||demo} onClick={()=>promptAction(d,'cancel')}>Cancel</button>}
      </div></article>)}</div>}</section></div>}
    {tab==='holds'&&<div className="shield-grid-block"><section className="shield-card"><h3>Create manual safety hold</h3><p>Stop managed drafts for an account while a review is underway.</p><form className="shield-form" onSubmit={createHold}><label>Account<select value={holdAccount} onChange={e=>setHoldAccount(e.target.value)}>{accounts.map(a=><option value={a.id} key={a.id}>u/{a.username}</option>)}</select></label><label>Reason<textarea rows={4} value={holdReason} onChange={e=>setHoldReason(e.target.value)} placeholder="Why is activity being held?" required/></label><button className="shield-button" disabled={busy||demo||!accounts.length} type="submit"><Icon name="lock" size={15}/> Apply hold</button></form></section><section className="shield-card"><h3>Hold history</h3>{data.holds.length===0?<div className="shield-empty">No safety holds yet.</div>:data.holds.map(h=><article className="shield-hold" key={h.id}><div className="shield-draft-top"><strong>u/{names[h.account_id]||'Account'}</strong><S state={h.released_at?'approved':'held'}/></div><p>{h.reason}</p><small>{h.source} · {time(h.created_at)}</small>{!h.released_at&&<button className="shield-button shield-secondary" disabled={busy||demo} onClick={()=>releaseHold(h)}>Release after review</button>}</article>)}</section></div>}
    {tab==='collisions'&&<section className="shield-card"><h3>Cross-account overlap analysis</h3><p>Checks current managed drafts for matching content and repeated destinations across different accounts. This helps the team avoid repetitive or coordinated spam.</p>{!collisions.length?<div className="shield-empty">No overlaps detected in recent managed drafts, or no comparable drafts are available.</div>:collisions.map(c=><div className="shield-listrow" key={c.draft_id}><div><strong>Draft {c.draft_id.slice(0,8)}</strong>{c.matches.map(m=><p key={m.draft_id}>{m.reason} · Draft {m.draft_id.slice(0,8)}</p>)}</div><S state="review"/></div>)}</section>}
    {tab==='incidents'&&<div className="shield-grid-block"><section className="shield-card"><h3>New incident</h3><p>Track investigations, review progress, and appeals without attempting to circumvent platform enforcement.</p><form className="shield-form" onSubmit={createIncident}><label>Account<select value={incident.accountId} onChange={e=>setIncident(i=>({...i,accountId:e.target.value}))}>{accounts.map(a=><option value={a.id} key={a.id}>u/{a.username}</option>)}</select></label><label>Issue summary<input value={incident.summary} maxLength={500} required onChange={e=>setIncident(i=>({...i,summary:e.target.value}))} placeholder="Describe the issue"/></label><label>Investigation notes<textarea rows={4} maxLength={2000} value={incident.notes} onChange={e=>setIncident(i=>({...i,notes:e.target.value}))}/></label><button type="submit" className="shield-button" disabled={busy||demo||!accounts.length}>Create incident</button></form></section><section className="shield-card"><h3>Recovery & appeals tracker</h3>{!data.incidents.length?<div className="shield-empty">No incidents logged.</div>:data.incidents.map(i=><article className="shield-hold" key={i.id}><div className="shield-draft-top"><strong>u/{names[i.account_id]||'Account'}</strong><span className="shield-state">{i.status}</span></div><p><b>{i.summary}</b></p><p>{i.notes}</p><small>{time(i.created_at)}</small><div className="shield-actions">{['reviewing','appealed','resolved','open'].filter(s=>s!==i.status).map(s=><button key={s} disabled={busy||demo} onClick={()=>changeIncident(i.id,s)}>Mark {s}</button>)}</div></article>)}</section></div>}
    {tab==='audit'&&<section className="shield-card"><h3>Decision audit trail</h3><p>Events are stored in Supabase, including draft creation, review actions, holds, releases, and operator-reported outcomes.</p>{data.events.length===0?<div className="shield-empty">No events yet.</div>:<div className="shield-tablewrap"><table className="shield-table"><thead><tr><th>Time</th><th>Account</th><th>Event</th><th>Details</th></tr></thead><tbody>{data.events.map(e=><tr key={e.id}><td>{time(e.created_at)}</td><td>{names[e.account_id]?'u/'+names[e.account_id]:'System'}</td><td>{e.event_type.replaceAll('_',' ')}</td><td><span className="shield-event-detail">{e.details?.reason||e.details?.intervention?.reason||e.details?.visibility||e.details?.state||'—'}</span></td></tr>)}</tbody></table></div>}</section>}
    {tab==='lab'&&<DetectionLab/>}
  </div>;
}
