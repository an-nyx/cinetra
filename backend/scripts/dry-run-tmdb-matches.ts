import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/database/prisma';

type Candidate = { id: number; name: string; original_name?: string; first_air_date?: string; overview?: string; poster_path?: string; vote_count?: number };
const api = axios.create({ baseURL: 'https://api.themoviedb.org/3', headers: { Authorization: process.env.API_AUTHORIZATION }, timeout: 10000 });
const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s: string) => new Set(norm(s).split(' ').filter(w => w.length > 3));
const overlap = (a: string, b: string) => { const x=tokens(a), y=tokens(b); if (!x.size || !y.size) return 0; let n=0; for(const t of x) if(y.has(t)) n++; return n/x.size; };
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main(){
 if(!process.env.API_AUTHORIZATION||process.env.API_AUTHORIZATION.includes('<')) throw new Error('TMDB API_AUTHORIZATION is required; no provider fallback is allowed.');
 const shows=await prisma.show.findMany({orderBy:{name:'asc'},select:{id:true,name:true,overview:true,posterURL:true,tmdbId:true,seasonsWatched:true,episodesWatched:true,status:true,completed:true,favorite:true,episodeWatches:{select:{season:true,episode:true}}}});
 const rows:any[]=[];
 for(let i=0;i<shows.length;i+=8){
  await Promise.all(shows.slice(i,i+8).map(async s=>{
   try {
    const search=await api.get('/search/tv',{params:{query:s.name,include_adult:false}}); const candidates:(Candidate[])=(search.data.results||[]).slice(0,8);
    const scored=candidates.map(c=>{const titleExact=norm(s.name)===norm(c.name),originalExact=!!c.original_name&&norm(s.name)===norm(c.original_name);const posterMatch=!!s.posterURL&&!!c.poster_path&&s.posterURL.split('/').pop()?.split('?')[0]===c.poster_path.split('/').pop();const description=overlap(s.overview||'',c.overview||'');return {...c,titleExact,originalExact,posterMatch,description};}).sort((a,b)=>Number(b.posterMatch)-Number(a.posterMatch)||Number(b.titleExact||b.originalExact)-Number(a.titleExact||a.originalExact)||b.description-a.description||(b.vote_count||0)-(a.vote_count||0));
    const top=scored[0]; if(!top){rows.push({showId:s.id,name:s.name,progress:`S${s.seasonsWatched}E${s.episodesWatched}`,classification:'no reliable match',existingTmdbId:s.tmdbId,proposedTmdbId:null,candidates:[]});return;}
    let detail:any=null;try{detail=(await api.get(`/tv/${top.id}`)).data}catch{}
    const alternatives=scored.slice(0,5).map(c=>({tmdbId:c.id,title:c.name,originalTitle:c.original_name||null,year:c.first_air_date?.slice(0,4)||null,posterMatch:c.posterMatch,titleExact:c.titleExact,originalTitleExact:c.originalExact,overviewOverlap:Number(c.description.toFixed(2)),overview:c.overview||'',posterPath:c.poster_path||null,votes:c.vote_count||0}));
    const runner=scored[1];const corroborated=top.titleExact||top.originalExact;const strongDescription=top.description>=0.55;const independentSignals=Number(corroborated)+Number(top.posterMatch)+Number(strongDescription);
    let classification:'high confidence'|'uncertain'|'no reliable match'='no reliable match';
    if(independentSignals>=3&&(!runner||!(runner.titleExact||runner.originalExact)||runner.description<0.55)&&top.posterMatch)classification='high confidence';
    else if(independentSignals>=1)classification='uncertain';
    const episodes=detail?.seasons?.filter((x:any)=>x.season_number>0)||[];
    const selected=episodes.find((x:any)=>x.season_number===s.seasonsWatched);
    const counterConflict=s.episodesWatched>0&&selected&&s.episodesWatched>selected.episode_count;
    rows.push({showId:s.id,name:s.name,progress:`S${s.seasonsWatched}E${s.episodesWatched}`,status:s.status||(s.completed?'completed':'unset'),favorite:s.favorite,individualWatchCount:s.episodeWatches.length,existingTmdbId:s.tmdbId,classification,proposedTmdbId:s.tmdbId|| (classification==='high confidence'?top.id:null),evidence:{candidateTitle:top.name,originalTitle:top.original_name||null,year:top.first_air_date?.slice(0,4)||null,exactTitle:corroborated,posterPathMatch:top.posterMatch,overviewOverlap:Number(top.description.toFixed(2)),independentSignals,seasonCount:episodes.length,selectedSeasonEpisodeCount:selected?.episode_count??null,counterExceedsKnownSeason:!!counterConflict},candidates:alternatives});
   }catch(e:any){rows.push({showId:s.id,name:s.name,progress:`S${s.seasonsWatched}E${s.episodesWatched}`,existingTmdbId:s.tmdbId,classification:'uncertain',error:e.response?.status?`TMDB HTTP ${e.response.status}`:'TMDB request failed',proposedTmdbId:null,candidates:[]});}
  }));
  if(i+8<shows.length)await sleep(160);
 }
 const counts=rows.reduce((a,r)=>(a[r.classification]=(a[r.classification]||0)+1,a),{} as Record<string,number>);const ids=new Map<number,string[]>();for(const r of rows)if(r.proposedTmdbId){ids.set(r.proposedTmdbId,[...(ids.get(r.proposedTmdbId)||[]),r.showId]);}
 const conflicts=[...ids].filter(([,showIds])=>showIds.length>1).map(([tmdbId,showIds])=>({tmdbId,showIds}));
 for(const r of rows)if(r.proposedTmdbId&&conflicts.some(c=>c.tmdbId===r.proposedTmdbId)){r.classification='uncertain';r.proposedTmdbId=null;r.evidence.conflict='TMDB ID proposed for multiple library shows';}
 const finalCounts=rows.reduce((a,r)=>(a[r.classification]=(a[r.classification]||0)+1,a),{} as Record<string,number>);
 const report={createdAt:new Date().toISOString(),provider:'TMDB only',totalShows:shows.length,existingTmdbIds:shows.filter(s=>s.tmdbId).length,legacyProgressShows:shows.filter(s=>s.seasonsWatched||s.episodesWatched).length,classificationCounts:finalCounts,duplicateTmdbIdConflicts:conflicts,assumptions:['Legacy counters represent viewing position, never total series size.','Season-zero specials are excluded from the provider season structure used for progress.','No production records were modified.','High confidence requires exact title/original title, exact saved TMDB poster path, strong description overlap, and no close runner-up.'],rows};
 const out=path.resolve(process.argv[2]||'docs/tmdb-match-dry-run.json');fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({out,totalShows:report.totalShows,existingTmdbIds:report.existingTmdbIds,legacyProgressShows:report.legacyProgressShows,classificationCounts:finalCounts,duplicateTmdbIdConflicts:conflicts.length}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>prisma.$disconnect());
