import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../lib/api.js';

const initialDraft = { subreddit:'', kind:'post', title:'', text:'', url:'', rulesText:'' };
const initialOnboarding = { email_verified:null, two_factor_enabled:null, rules_reviewed:null, notes:'' };
const triValue = v => v === true ? 'yes' : v === false ? 'no' : 'unknown';
const fromTri = v => v === 'yes' ? true : v === 'no' ? false : null;
const LABELS = {hold:'Hold for review', review:'Needs review', ready:'No issues detected'};
const SEVERITY = {hold:'critical',high:'critical',review:'warning',ready:'healthy'};
function Decision({value}) {return <span className={`preventer-decision prevention-${SEVERITY[value] || 'warning'}`}><Icon name={value==='ready'?'circleCheck':'alert'} size={15}/>{LABELS[value]||'Not assessed'}</span>}
function Finding({finding}) {return <li className="preventer-finding"><span className={`preventer-dot prevention-${SEVERITY[finding.severity]||'warning'}`}/><div><strong>{finding.title}</strong><p>{finding.detail}</p></div></li>}
function Metric({label,value,description}) {return <div className="preventer-metric"><span>{label}</span><strong>{value ?? '—'}</strong>{description&&<small>{description}</small>}</div>}

export default function Preventer({ accounts=[], demo=false }) {
  const [selectedId,setSelectedId]=useState('');
  const [tab,setTab]=useState('readiness');
  const [data,setData]=useState(null);
  const [onboarding,setOnboarding]=useState(initialOnboarding);
  const [draft,setDraft]=useState(initialDraft);
  const [scan,setScan]=useState(null);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [scanning,setScanning]=useState(false);
  const [message,setMessage]=useState('');
  const fetchVersion=useRef(0);
  const selected=accounts.find(a=>a.id===selectedId);

  useEffect(()=>{
    if(!accounts.some(a=>a.id===selectedId)) setSelectedId(accounts[0]?.id||'');
  },[accounts,selectedId]);
  const reload=useCallback(async()=>{
    const current=++fetchVersion.current;
    if(demo || !selectedId){setData(null);setLoading(false);return;}
    setLoading(true);setMessage('');
    try {
      const result=await api.preventerAccount(selectedId);
      if(current !== fetchVersion.current)return;
      setData(result);
      setOnboarding({...initialOnboarding,...(result.readiness?.onboarding||{})});
    }catch(err){if(current===fetchVersion.current){setData(null);setMessage(err.message);}}
    finally{if(current===fetchVersion.current)setLoading(false);}
  },[selectedId,demo]);
  useEffect(()=>{setScan(null);reload();},[reload]);

  const save=async(e)=>{
    e.preventDefault();if(demo || !selectedId)return;
    setSaving(true);setMessage('');
    try {
      const result=await api.preventerOnboarding(selectedId,onboarding);
      setData(prev=>prev?{...prev,readiness:result.readiness}:prev);
      setMessage('Onboarding checklist saved. These settings are self-reported.');
    }catch(err){setMessage(err.message);}finally{setSaving(false);}
  };
  const doScan=async(e)=>{
    e.preventDefault();if(demo || !selectedId)return;
    setScanning(true);setMessage('');setScan(null);
    try {
      const result=await api.preventerScan({...draft,accountId:selectedId});
      setScan(result.report);
      setData(prev=>prev?{...prev,activity:result.activity,readiness:result.readiness}:prev);
    }catch(err){setMessage(err.message);}finally{setScanning(false);}
  };
  const updateDraft=(key,value)=>{setDraft(d=>({...d,[key]:value}));setScan(null)};
  const updateOnboarding=(key,value)=>setOnboarding(d=>({...d,[key]:value}));

  return <div className="screen flow-in preventer-screen">
    <div className="page-lead"><div><div className="eyebrow"><span className="eyebrow-line"/> PREVENTION WORKSPACE</div><h2>Catch problems before publishing</h2><p>Analyze monitored activity, review account readiness and inspect drafts without posting to Reddit.</p></div></div>
    <div className="preventer-disclaimer"><Icon name="info" size={17}/> <span>Internal heuristics based on stored monitoring data. These checks are not Reddit's CQS, guaranteed eligibility, or proof that a submission will be approved.</span></div>
    <section className="panel preventer-account-bar"><div><label htmlFor="preventer-account">Account to review</label><select id="preventer-account" value={selectedId} onChange={e=>setSelectedId(e.target.value)} disabled={!accounts.length}>{accounts.length?accounts.map(a=><option key={a.id} value={a.id}>u/{a.username}{a.label?` · ${a.label}`:''}</option>):<option value="">No monitored accounts</option>}</select></div><div className="preventer-bar-actions">{selected&&<a href={`#/account/${selectedId}`} className="preventer-secondary">Account details <Icon name="arrowRight" size={15}/></a>}<button className="btn btn-outline" onClick={reload} disabled={!selectedId||demo||loading}><Icon name="refresh" size={16}/>{loading?' Loading…':' Refresh analysis'}</button></div></section>
    {demo?<section className="panel preventer-info"><Icon name="database" size={25}/><h3>Switch to Live API to use Preventer</h3><p>Preventer needs real account checks and historical content stored by your Express backend. Demo accounts are not analyzed or saved.</p><a href="#/settings" className="preventer-secondary">Open Settings <Icon name="arrowRight" size={14}/></a></section>:
    !accounts.length?<section className="panel preventer-info"><h3>No accounts added yet</h3><p>Add an account to the Monitor and run a health check before using its readiness and draft review.</p><a href="#/accounts" className="preventer-secondary">Go to Accounts</a></section>:
    <>
    {message&&<div role="status" className="preventer-message">{message}</div>}
    <nav className="preventer-tabs" aria-label="Prevention features">
      <button type="button" className={tab==='readiness'?'active':''} onClick={()=>setTab('readiness')}>Account readiness</button>
      <button type="button" className={tab==='activity'?'active':''} onClick={()=>setTab('activity')}>Activity patterns</button>
      <button type="button" className={tab==='draft'?'active':''} onClick={()=>setTab('draft')}>Pre-post scanner</button>
    </nav>
    {loading && !data?<div className="panel preventer-info"><Icon name="refresh" className="spin"/> Loading stored account history…</div>:null}
    {data && tab==='readiness'&&<div className="preventer-two-col">
      <section className="panel preventer-block"><header><div><h3>Readiness assessment</h3><p>Based on the last successful monitor check and saved onboarding answers</p></div><Decision value={data.readiness.decision}/></header>
        <div className="preventer-metrics"><Metric label="Internal readiness" value={`${data.readiness.score}/100`} description="Not Reddit CQS"/><Metric label="Account age" value={data.readiness.age_days!=null?`${data.readiness.age_days}d`:'Unknown'}/><Metric label="Total karma" value={data.readiness.karma??'Unknown'}/></div>
        <h4>What needs attention</h4><ul className="preventer-findings">{data.readiness.findings.length?data.readiness.findings.map((f,i)=><Finding key={`${f.code}-${i}`} finding={f}/>):<li className="preventer-clean"><Icon name="circleCheck" size={19}/> No issues found in available data; community eligibility still depends on Reddit and its moderators.</li>}</ul><p className="preventer-footnote">{data.readiness.disclaimer}</p>
      </section>
      <section className="panel preventer-block"><header><div><h3>Account onboarding checklist</h3><p>Manually confirmed account-security and community-review steps</p></div><Icon name="shield" size={24}/></header>
        <form onSubmit={save} className="preventer-form">
          {[["email_verified","Email address verified","Confirm this in the account's Reddit settings"],["two_factor_enabled","Two-factor authentication enabled","Confirm this in the account's security settings"],["rules_reviewed","Relevant community rules reviewed","Revisit rules for each target subreddit"]].map(([key,label,help])=><label key={key} className="preventer-check-row"><span><strong>{label}</strong><small>{help}</small></span><select value={triValue(onboarding[key])} onChange={e=>updateOnboarding(key,fromTri(e.target.value))}><option value="unknown">Not confirmed</option><option value="yes">Yes</option><option value="no">No</option></select></label>)}
          <label className="preventer-field">Operator notes<textarea maxLength={1000} rows={3} value={onboarding.notes||''} onChange={e=>updateOnboarding('notes',e.target.value)} placeholder="Optional onboarding notes; never enter passwords or recovery codes."/></label>
          <button className="btn btn-primary" type="submit" disabled={saving}>{saving?'Saving…':'Save onboarding checklist'}</button>
        </form>
      </section>
    </div>}
    {data && tab==='activity'&&<div className="preventer-stack"><section className="panel preventer-block"><header><div><h3>Activity pattern analysis</h3><p>Last 30 days of content successfully collected by the Monitor</p></div><Decision value={data.activity.signals.some(s=>s.severity==='high')?'review':'ready'}/></header>
      <div className="preventer-metrics preventer-metrics-four"><Metric label="Tracked items" value={data.activity.totals.items}/><Metric label="Last 7 days" value={data.activity.totals.last_7_days}/><Metric label="Removed" value={data.activity.totals.removed}/><Metric label="Removal rate" value={`${data.activity.totals.removal_rate}%`}/></div>
      <div className="preventer-two-col preventer-inside"><div><h4>Activity signals</h4><ul className="preventer-findings">{data.activity.signals.length?data.activity.signals.map((f,i)=><Finding key={`${f.code}-${i}`} finding={f}/>):<li className="preventer-clean"><Icon name="circleCheck" size={19}/> No pattern warnings in stored content.</li>}</ul></div><div><h4>Subreddit distribution</h4>{data.activity.top_subreddits.length?<ul className="preventer-community">{data.activity.top_subreddits.map(s=><li key={s.name}><span>r/{s.name}</span><strong>{s.count} items</strong></li>)}</ul>:<p className="preventer-muted">No subreddit activity captured.</p>}<h4>Additional context</h4><p className="preventer-muted">Posts: {data.activity.totals.posts} · Comments: {data.activity.totals.comments} · Last 24 hours: {data.activity.totals.last_24_hours}</p><p className="preventer-muted">Previous 23 days: {data.activity.totals.previous_23_days}{data.activity.busiest_day?` · Busiest day ${data.activity.busiest_day.date}: ${data.activity.busiest_day.count} items`:''}</p></div></div>
      <p className="preventer-footnote">{data.activity.sample_limitations}</p>
    </section></div>}
    {data && tab==='draft'&&<div className="preventer-two-col"><section className="panel preventer-block"><header><div><h3>Scan a draft</h3><p>Drafts are analyzed by your local backend; nothing is posted or saved to the database</p></div><Icon name="file" size={24}/></header>
      <form className="preventer-form" onSubmit={doScan}><div className="preventer-field-row"><label className="preventer-field">Subreddit<input required maxLength={24} value={draft.subreddit} onChange={e=>updateDraft('subreddit',e.target.value)} placeholder="e.g. AskReddit"/></label><label className="preventer-field">Content type<select value={draft.kind} onChange={e=>updateDraft('kind',e.target.value)}><option value="post">Post</option><option value="comment">Comment</option></select></label></div>
      {draft.kind==='post'&&<label className="preventer-field">Title<input maxLength={300} value={draft.title} onChange={e=>updateDraft('title',e.target.value)} placeholder="Proposed post title"/></label>}
      <label className="preventer-field">Content<textarea rows={6} maxLength={10000} value={draft.text} onChange={e=>updateDraft('text',e.target.value)} placeholder="Paste your post or comment draft"/></label>
      <label className="preventer-field">Optional destination URL<input type="url" maxLength={2000} value={draft.url} onChange={e=>updateDraft('url',e.target.value)} placeholder="https://example.com"/></label>
      <label className="preventer-field">Subreddit rules (operator-supplied)<textarea rows={4} maxLength={4000} value={draft.rulesText} onChange={e=>updateDraft('rulesText',e.target.value)} placeholder="Paste relevant community rules here. If omitted, the scanner will flag them as unreviewed."/></label>
      <button type="submit" className="btn btn-primary" disabled={scanning}>{scanning?'Scanning…':'Scan draft'}</button></form></section>
      <section className="panel preventer-block"><header><div><h3>Pre-publication findings</h3><p>Warnings are advisory; no content is sent to Reddit</p></div>{scan&&<Decision value={scan.decision}/>}</header>
        {scan?<><p className="preventer-muted">r/{scan.subreddit} · {scan.kind} · Reviewed {new Date(scan.scanned_at).toLocaleString()}</p><ul className="preventer-findings">{scan.flags.length?scan.flags.map((f,i)=><Finding key={`${f.code}-${i}`} finding={f}/>):<li className="preventer-clean"><Icon name="circleCheck" size={19}/> No predefined issues detected. You should still check subreddit rules and moderator decisions.</li>}</ul><p className="preventer-footnote">{scan.disclaimer}</p></>:<div className="preventer-placeholder"><Icon name="search" size={34}/><strong>No draft scanned yet</strong><p>Select an account, enter your draft, and run a check to see the results here.</p></div>}
      </section></div>}
    </>}
  </div>;
}
