const dayAgo = (days, hours=0) => new Date(Date.now() - (days * 24 + hours) * 3600e3).toISOString();
export const seedAccounts = [
 {id:'demo-a1',username:'northstar_notes',status:'healthy',risk_score:12,karma:4820,stealth_mode:false,last_checked_at:dayAgo(0,0.2),created_utc:dayAgo(390),posts_30d:18,comments_30d:84,removed_30d:0},
 {id:'demo-a2',username:'curious_cedar',status:'healthy',risk_score:19,karma:2310,stealth_mode:true,last_checked_at:dayAgo(0,0.4),created_utc:dayAgo(250),posts_30d:9,comments_30d:42,removed_30d:1},
 {id:'demo-a3',username:'pixel_trails',status:'at_risk',risk_score:68,karma:940,stealth_mode:true,last_checked_at:dayAgo(0,1.1),created_utc:dayAgo(84),posts_30d:24,comments_30d:31,removed_30d:5},
 {id:'demo-a4',username:'paper_helios',status:'healthy',risk_score:8,karma:9102,stealth_mode:false,last_checked_at:dayAgo(0,0.6),created_utc:dayAgo(510),posts_30d:12,comments_30d:106,removed_30d:0},
 {id:'demo-a5',username:'orbit_morning',status:'shadowbanned',risk_score:96,karma:185,stealth_mode:true,last_checked_at:dayAgo(0,2),created_utc:dayAgo(28),posts_30d:14,comments_30d:28,removed_30d:11},
 {id:'demo-a6',username:'freshwater_ink',status:'warning',risk_score:43,karma:1398,stealth_mode:false,last_checked_at:dayAgo(0,3),created_utc:dayAgo(123),posts_30d:15,comments_30d:39,removed_30d:3},
 {id:'demo-a7',username:'lime_antenna',status:'healthy',risk_score:16,karma:6400,stealth_mode:false,last_checked_at:dayAgo(1,1),created_utc:dayAgo(290),posts_30d:8,comments_30d:69,removed_30d:0},
 {id:'demo-a8',username:'little_archive',status:'check_failed',risk_score:27,karma:2100,stealth_mode:false,last_checked_at:dayAgo(1,5),created_utc:dayAgo(201),posts_30d:11,comments_30d:45,removed_30d:2},
];
export const seedAlerts = [
 {id:'demo-l1',account_id:'demo-a5',username:'orbit_morning',type:'shadowban_detected',severity:'critical',message:'Profile is not visible in the public logged-out view.',created_at:dayAgo(0,2),resolved_at:null},
 {id:'demo-l2',account_id:'demo-a3',username:'pixel_trails',type:'risk_high',severity:'high',message:'5 recent items were removed. Risk score increased to 68.',created_at:dayAgo(0,1),resolved_at:null},
 {id:'demo-l3',account_id:'demo-a8',username:'little_archive',type:'check_failing',severity:'medium',message:'Repeated public visibility checks did not complete.',created_at:dayAgo(1,5),resolved_at:null},
 {id:'demo-l4',account_id:'demo-a6',username:'freshwater_ink',type:'content_removal',severity:'medium',message:'3 posts or comments recently disappeared from public listings.',created_at:dayAgo(2),resolved_at:dayAgo(0,7)},
];
export const seedChecks = Array.from({length:18}, (_,i)=>({
 id:`demo-c${i}`, account_id:i%3===0?'demo-a3':i%3===1?'demo-a5':'demo-a1',
 created_at:dayAgo(17-i), risk_score: i%3===0? 28+Math.round(i*2.1):i%3===1?75+Math.round(i*.8):18-Math.round(i*.3),
 karma:i%3===0?600+i*20:i%3===1?120+i*4:4100+i*40,
 status: i%3===1?'shadowbanned':i%3===0?'at_risk':'healthy'
}));
export const riskTrend = [{name:'Mon',risk:26,karma:4800},{name:'Tue',risk:24,karma:4850},{name:'Wed',risk:31,karma:4890},{name:'Thu',risk:25,karma:4910},{name:'Fri',risk:39,karma:4960},{name:'Sat',risk:32,karma:5010},{name:'Sun',risk:24,karma:5060}];
export const blankFingerprint = {userAgent:'',timezone:'',locale:'en-US',viewport:{width:1440,height:900}};
export const seedContent = [
 {id:'demo-post-1',account_id:'demo-a3',type:'post',subreddit:'r/technology',title:'Thoughts on the latest browser update?',body:'Community discussion about a recently released browser update.',status:'visible',created_at:dayAgo(1)},
 {id:'demo-comment-2',account_id:'demo-a3',type:'comment',subreddit:'r/AskReddit',title:'Reply in a public question thread',body:'A short reply about productivity workflows.',status:'removed',removed_by_category:'moderator',created_at:dayAgo(2)},
 {id:'demo-post-3',account_id:'demo-a5',type:'post',subreddit:'r/learnprogramming',title:'A beginner debugging question',body:'An example programming question for the demo workspace.',status:'removed',removed_by_category:'unknown',created_at:dayAgo(4)},
 {id:'demo-comment-4',account_id:'demo-a6',type:'comment',subreddit:'r/DIY',title:'Reply to a home repair discussion',body:'General maintenance advice.',status:'visible',created_at:dayAgo(4)},
 {id:'demo-post-5',account_id:'demo-a1',type:'post',subreddit:'r/books',title:'Favorite science fiction reads this year',body:'A thread about book recommendations.',status:'visible',created_at:dayAgo(1)},
 {id:'demo-comment-6',account_id:'demo-a2',type:'comment',subreddit:'r/technology',title:'Discussion reply',body:'Thoughts on open source tools.',status:'visible',created_at:dayAgo(3)},
];
// Vote history as GET /api/accounts/:id/votes returns it. demo-a3 and demo-a5 voted on one same post, so the
// shared-votes warning has something to show.
const vote=(account_id,item_id,kind,direction,subreddit,slug,days)=>({account_id,item_id,kind,direction,subreddit,title:slug.replaceAll('_',' '),permalink:`https://www.reddit.com/r/${subreddit}/comments/${kind==='post'?item_id.slice(3):'demo1'}/${slug}/${kind==='comment'?`${item_id.slice(3)}/`:''}`,first_seen_at:dayAgo(days),updated_at:dayAgo(0,3)});
export const seedVotes = [
 vote('demo-a1','t3_1q2w3e','post','up','books','favorite_science_fiction_reads_this_year',6),
 vote('demo-a1','t3_1q2w3f','post','up','books','what_are_you_reading_this_week',6),
 vote('demo-a1','t1_m4k2p9a','comment','up','books','what_are_you_reading_this_week',6),
 vote('demo-a1','t1_m4k2p9b','comment','down','technology','new_browser_update_discussion',6),
 vote('demo-a3','t3_9z8x7c','post','up','technology','thoughts_on_the_latest_browser_update',2),
 vote('demo-a3','t3_9z8x7d','post','up','gadgets','best_budget_headphones',2),
 vote('demo-a3','t1_n7b6v5a','comment','up','technology','thoughts_on_the_latest_browser_update',2),
 vote('demo-a5','t3_9z8x7c','post','up','technology','thoughts_on_the_latest_browser_update',1),
 vote('demo-a5','t3_8y7u6i','post','down','learnprogramming','a_beginner_debugging_question',1),
];
export function demoVotes(accountId,{direction,kind}={}){
 const own=seedVotes.filter(v=>v.account_id===accountId);
 const count=(key,value)=>own.filter(v=>v[key]===value).length;
 const subs=new Map();for(const v of own){const s=subs.get(v.subreddit)||{name:v.subreddit,up:0,down:0};s[v.direction]++;subs.set(v.subreddit,s)}
 const usernames=Object.fromEntries(seedAccounts.map(a=>[a.id,a.username]));
 const matching=own.filter(v=>(!direction||v.direction===direction)&&(!kind||v.kind===kind));
 return {
  summary:{total:own.length,up:count('direction','up'),down:count('direction','down'),posts:count('kind','post'),comments:count('kind','comment'),by_subreddit:[...subs.values()].sort((a,b)=>b.up+b.down-(a.up+a.down))},
  votes:matching,matching:matching.length,last_imported_at:own.length?own[0].updated_at:null,
  shared:own.map(v=>({...v,others:seedVotes.filter(o=>o.item_id===v.item_id&&o.account_id!==accountId).map(o=>({account_id:o.account_id,username:usernames[o.account_id],direction:o.direction}))})).filter(v=>v.others.length),
 };
}
