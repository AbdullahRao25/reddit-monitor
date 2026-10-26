const box=document.getElementById('status');
fetch('http://127.0.0.1:4000/api/shield/overview',{signal:AbortSignal.timeout(6000)})
 .then(async r=>{const j=await r.json();if(!r.ok)throw Error(j.error||`HTTP ${r.status}`);return j;})
 .then(d=>{const holds=d.holds.filter(h=>!h.released_at).length;const pending=d.drafts.filter(x=>['held','review'].includes(x.state)).length;
   box.replaceChildren();const a=document.createElement('div');a.textContent=`${holds} active safety holds`;const b=document.createElement('div');b.textContent=`${pending} drafts need attention`;box.append(a,b);})
 .catch(e=>{box.className='error';box.textContent=`Local API unavailable: ${e.message}`;});
document.getElementById('open').addEventListener('click',()=>chrome.tabs.create({url:'http://127.0.0.1:5173/#/shield'}));
