import React, { useState } from 'react';
export default function Chart({data=[],dataKey='risk',height=185,stroke='#9b8afc',fill=true,suffix='',maxValue,showAxis=true}){
 const [active,setActive]=useState(-1);
 const nums=data.map(x=>Number(x[dataKey]||0));
 const max=Math.max(maxValue||0,...nums,1), min=0;
 const w=720,h=height,padL=showAxis?34:2,padR=12,padT=18,padB=showAxis?26:6;
 const x=(i)=>padL+(i/Math.max(1,data.length-1))*(w-padL-padR);
 const y=(v)=>padT+(1-(Number(v)-min)/(max-min))*(h-padT-padB);
 const pts=data.map((d,i)=>`${x(i)},${y(d[dataKey])}`).join(' ');
 const area=`M${pts.replaceAll(' ',' L')} L${x(data.length-1)},${h-padB} L${x(0)},${h-padB} Z`;
 if(!data.length)return <div className="empty-chart">Not enough check history to draw a trend yet.</div>;
 return <div className="chart" style={{height}}><svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${dataKey} trend chart`}>
 <defs><linearGradient id={`area-${dataKey}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={stroke} stopOpacity=".22"/><stop offset="100%" stopColor={stroke} stopOpacity="0"/></linearGradient></defs>
 {[0,.25,.5,.75,1].map(v=><g key={v}><line x1={padL} x2={w-padR} y1={y(v*max)} y2={y(v*max)} stroke="currentColor" className="chart-grid"/>{showAxis&&<text x={padL-9} y={y(v*max)+4} textAnchor="end" className="chart-label">{Math.round(v*max)}{suffix}</text>}</g>)}
 {fill&&<path d={area} fill={`url(#area-${dataKey})`}/>}
 <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
 {data.map((d,i)=><g key={i}><rect x={x(i)-(w-padL-padR)/Math.max(data.length,1)/2} y={0} width={(w-padL-padR)/Math.max(data.length,1)} height={h-padB} fill="transparent" onMouseEnter={()=>setActive(i)} onMouseLeave={()=>setActive(-1)} onFocus={()=>setActive(i)} tabIndex="0" role="button" aria-label={`${d.name||new Date(d.created_at).toLocaleDateString()}, ${d[dataKey]}${suffix}`}/>{active===i&&<><line x1={x(i)} x2={x(i)} y1={padT} y2={h-padB} stroke={stroke} opacity=".65" strokeDasharray="4 4"/><circle cx={x(i)} cy={y(d[dataKey])} r="5" fill={stroke} stroke="var(--surface)" strokeWidth="3"/></>}</g>)}
 {showAxis&&data.map((d,i)=><text key={i} className="chart-label" textAnchor="middle" x={x(i)} y={h-4}>{data.length>10?(i%Math.ceil(data.length/6)===0?d.name:''):d.name}</text>)}
 </svg>{active>=0&&<div className="chart-tip" style={{left:`${Math.min(82,Math.max(8,(x(active)/w)*100))}%`}}><strong>{data[active]?.[dataKey]}{suffix}</strong><small>{data[active]?.name}</small></div>}</div>
}
