import React, {useCallback,useEffect,useState} from 'react';
import {api} from '../lib/api.js';

const pretty = value => value==null?'—':value;
const when = value => value?new Date(value).toLocaleString():'—';
const selectionDefault = (accounts)=>accounts[0]?.id||'';

export default function PreventionOps({accounts=[],demo=false}) {
  const [selectedId,setSelectedId]=useState(()=>selectionDefault(accounts));
  const [overview,setOverview]=useState(null);
  const [detail,setDetail]=useState(null);
  const [votes,setVotes]=useState(null);
  const [reason,setReason]=useState('');
  const [completion,setCompletion]=useState('Reviewed the reason and available evidence.');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  useEffect(()=>{if(!selectedId&&accounts.length)setSelectedId(selectionDefault(accounts));},[accounts,selectedId]);
  const refresh=useCallback(async()=>{
    if(demo||!selectedId)return;
    setBusy(true);setError('');
    try {
      const [o,d,v]=await Promise.all([api.preventionOverview(),api.preventionDetail(selectedId),api.preventionVoteSources(selectedId)]);
      setOverview(o);setDetail(d);setVotes(v);
    }catch(err){setError(err.message);}finally{setBusy(false);}
  },[demo,selectedId]);
  useEffect(()=>{setDetail(null);setVotes(null);refresh();},[refresh]);
  async function createReview(e){e.preventDefault();setBusy(true);setError('');setMessage('');
    try{await api.preventionHold(selectedId,reason);setReason('');setMessage('Review hold saved. This does not contact Reddit.');await refresh();}
    catch(err){setError(err.message);}finally{setBusy(false);}
  }
  async function complete(id,action){setBusy(true);setError('');setMessage('');
    try{await api.preventionComplete(selectedId,id,action,completion);setMessage(`Review ${action==='release'?'released for operator review':'cleared'}. No Reddit action was sent.`);await refresh();}
    catch(err){setError(err.message);}finally{setBusy(false);}
  }
  return <div className="screen flow-in prevention-ops">
    <div className="page-lead"><div><div className="eyebrow"><span className="eyebrow-line"/> PREVENTION OPERATIONS</div><h2>Review risks before action</h2><p>Account-health trends, safety plans, manually held work, and transparent vote-data sources.</p></div></div>
    <div className="preventer-disclaimer">No automated posting, proxy/fingerprint spoofing, or artificial engagement. Risk trends are internal estimates, not predictions of Reddit enforcement.</div>
    {demo?<section className="panel"><h3>Live data required</h3><p>Switch to Live API to review stored account history. No simulated results are shown here.</p></section>:
      !accounts.length?<section className="panel"><h3>No monitored accounts</h3><p>Add an account and run a health check first.</p></section>:
      <>
        <section className="panel prevention-toolbar"><label>Monitored account
          <select value={selectedId} onChange={e=>setSelectedId(e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>u/{a.username}</option>)}</select>
        </label><button type="button" className="btn btn-outline" disabled={busy} onClick={refresh}>{busy?'Loading…':'Refresh analysis'}</button></section>
        {error&&<div className="preventer-message" role="alert">{error}</div>}
        {message&&<div className="preventer-message" role="status">{message}</div>}
        {detail&&<>
        <section className="panel prevention-block"><h3>Internal account-health trend</h3>
          <div className="prevention-metrics"><div><strong>{pretty(detail.trend.score)}/100</strong><small>Latest risk score</small></div><div><strong>{detail.trend.direction}</strong><small>Trend direction</small></div><div><strong>{detail.trend.data_points}</strong><small>Successful observations</small></div><div><strong>{detail.queue.filter(r=>r.state==='held').length}</strong><small>Held reviews</small></div></div>
          <p>{detail.trend.explanation}</p>{detail.trend.stale&&<p className="prevention-warning">Last monitor result is stale. Refresh the account check before relying on this analysis.</p>}
          <p className="preventer-footnote">{detail.trend.disclaimer}</p>
        </section>
        <section className="panel prevention-block"><h3>Recommended review actions</h3><ol className="prevention-tasks">{detail.plan.tasks.map(t=><li key={t.code}><strong>{t.title}</strong><p>{t.description}</p></li>)}</ol>
          {detail.active_safety_hold&&<p className="prevention-warning">Shield hold active: {detail.active_safety_hold.reason}</p>}
        </section>
        <section className="panel prevention-block"><h3>Manual review queue</h3><p>Items remain stored across restarts. Releasing an item does not post to Reddit or approve a Shield draft.</p>
          <form className="prevention-form" onSubmit={createReview}><label htmlFor="review-reason">Reason to hold for review</label><textarea id="review-reason" minLength={10} maxLength={500} rows={2} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Describe the content or account problem…" required/><button className="btn btn-primary" disabled={busy||reason.trim().length<10}>Create review hold</button></form>
          <label htmlFor="review-completion">Release/clear justification</label><input id="review-completion" value={completion} maxLength={500} onChange={e=>setCompletion(e.target.value)}/>
          <div className="prevention-review-list">{detail.queue.length?detail.queue.map(item=><div key={item.id} className="prevention-review"><span><strong>{item.state.toUpperCase()}</strong> · {when(item.created_at)}<p>{item.reason}</p></span>{item.state==='held'&&<span className="prevention-actions"><button type="button" disabled={busy||completion.trim().length<10} onClick={()=>complete(item.id,'release')}>Release for review</button><button type="button" disabled={busy||completion.trim().length<10} onClick={()=>complete(item.id,'clear')}>Clear</button></span>}</div>):<p>No reviews recorded for this account.</p>}</div>
        </section>
        {votes&&<section className="panel prevention-block"><h3>Vote data provenance</h3>
          <div className="prevention-metrics"><div><strong>{votes.private_votes.upvotes}</strong><small>Owner-imported upvotes</small></div><div><strong>{votes.private_votes.downvotes}</strong><small>Owner-imported downvotes</small></div><div><strong>{votes.public_content_scores.items_with_score}</strong><small>Public items with scores</small></div><div><strong>{votes.public_content_scores.total_observed_net_score}</strong><small>Combined observed net score</small></div></div>
          <p className="preventer-footnote">{votes.warning}</p>
        </section>}
        </>}
        {overview&&<section className="panel prevention-block"><h3>Other monitored accounts</h3><div className="prevention-review-list">{overview.accounts.filter(a=>a.account_id!==selectedId).map(a=><div className="prevention-review" key={a.account_id}><span>u/{a.username} · {a.status} · {pretty(a.trend.score)}/100</span><span>{a.pending_reviews} held</span></div>)}</div></section>}
      </>}
  </div>;
}
