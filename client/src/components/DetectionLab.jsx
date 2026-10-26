import React,{useMemo,useState} from 'react';
// Deterministic local synthetic experiment. Never contacts Reddit.
function run(threshold,strictness) {
  let seed=94821;
  const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
  const rows=Array.from({length:300},(_,i)=>{
    const automated=i%4===0;
    const base=automated?52:20;
    const score=Math.min(100,Math.max(0,base+(rand()-.5)*55+(rand()-.5)*35));
    const before=score>=threshold;
    const after=score>=threshold-strictness;
    return {automated,before,after};
  });
  const scoreFor=key=>{
    const tp=rows.filter(r=>r.automated&&r[key]).length;
    const fp=rows.filter(r=>!r.automated&&r[key]).length;
    const fn=rows.filter(r=>r.automated&&!r[key]).length;
    return {tp,fp,fn,precision:tp+fp?Math.round(100*tp/(tp+fp)):100,recall:tp+fn?Math.round(100*tp/(tp+fn)):100};
  };
  return {before:scoreFor('before'),after:scoreFor('after')};
}
// Module level: a component defined inside DetectionLab would be a new type on every render and remount each time.
const Tile=({label,value,sub})=><div className="shield-tile"><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>;
export default function DetectionLab() {
  const [threshold,setThreshold]=useState(50);
  const [review,setReview]=useState(10);
  const result=useMemo(()=>run(threshold,review),[threshold,review]);
  return <div className="shield-grid-block">
    <section className="shield-card">
      <h3>Controlled detection research lab</h3>
      <p>This simulation runs entirely in your browser against 300 synthetic accounts (75 labeled automated). It is NOT Reddit's detection engine and doesn't use live account identities.</p>
      <label className="shield-label">Classifier threshold <strong>{threshold}</strong><input type="range" min="15" max="85" value={threshold} onChange={e=>setThreshold(Number(e.target.value))}/></label>
      <label className="shield-label">Additional review sensitivity <strong>{review}</strong><input type="range" min="0" max="25" value={review} onChange={e=>setReview(Number(e.target.value))}/></label>
      <p className="shield-note">Raising review sensitivity catches more simulated automated accounts, but can also flag more ordinary accounts. All data are generated with a fixed seed so experiments are reproducible.</p>
    </section>
    <section className="shield-card"><h3>Experiment results</h3><div className="shield-stats"><Tile label="Baseline recall" value={`${result.before.recall}%`} sub="Synthetic automated accounts detected"/><Tile label="Stricter recall" value={`${result.after.recall}%`} sub="After sensitivity adjustment"/><Tile label="False positives" value={result.after.fp} sub="Legitimate simulated accounts flagged"/><Tile label="Precision" value={`${result.after.precision}%`} sub="Correct among flagged accounts"/></div><table className="shield-table"><thead><tr><th>Metric</th><th>Baseline</th><th>More sensitive</th></tr></thead><tbody><tr><td>True positives</td><td>{result.before.tp}</td><td>{result.after.tp}</td></tr><tr><td>False positives</td><td>{result.before.fp}</td><td>{result.after.fp}</td></tr><tr><td>False negatives</td><td>{result.before.fn}</td><td>{result.after.fn}</td></tr></tbody></table></section>
  </div>;
}
