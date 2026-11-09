import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { prisma } from '../src/database/prisma';

const reportPath=process.argv[2]||'docs/tmdb-match-revalidation.json';
const apply=process.argv.includes('--apply');
async function main(){
 const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
 const eligible=report.results.filter((r:any)=>r.revalidated==='validated');
 const before=await prisma.show.findMany({where:{id:{in:eligible.map((r:any)=>r.showId)}},select:{id:true,name:true,tmdbId:true,seasonsWatched:true,episodesWatched:true,status:true,completed:true,favorite:true}});
 const byId=new Map(before.map(s=>[s.id,s]));
 type Change={showId:string;name:string;tmdbId:number;currentTmdbId:number|null};
 const changes:Change[]=eligible.map((r:any)=>({showId:r.showId,name:r.name,tmdbId:r.tmdbId,currentTmdbId:byId.get(r.showId)?.tmdbId??null}));
 const duplicateProposals=new Map<number,string[]>();for(const c of changes)duplicateProposals.set(c.tmdbId,[...(duplicateProposals.get(c.tmdbId)||[]),c.showId]);
 const dups=[...duplicateProposals].filter(([,ids])=>ids.length>1);
 const occupied=await prisma.show.findMany({where:{tmdbId:{in:changes.map(c=>c.tmdbId)}},select:{id:true,name:true,tmdbId:true}});
 const conflicts=occupied.filter(s=>changes.some(c=>c.tmdbId===s.tmdbId&&c.showId!==s.id));
 const summary={mode:apply?'apply':'dry-run',reportPath,reportSha256:crypto.createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex'),eligible:changes.length,alreadyLinked:changes.filter(c=>c.currentTmdbId===c.tmdbId).length,updates:changes.filter(c=>c.currentTmdbId===null).length,skipChanged:changes.filter(c=>c.currentTmdbId!==null&&c.currentTmdbId!==c.tmdbId).length,duplicateProposalConflicts:dups.length,occupiedIdConflicts:conflicts.length,rollbackBeforeImage:changes.filter(c=>c.currentTmdbId===null).map(c=>({showId:c.showId,previousTmdbId:null,appliedTmdbId:c.tmdbId}))};
 console.log(JSON.stringify(summary,null,2));
 if(!apply)return;
 const approval=process.env.TMDB_MATCH_APPROVAL;
 const backup=process.env.TMDB_PREWRITE_BACKUP;
 if(approval!==`APPROVE ${summary.reportSha256}`)throw Error('Explicit approval required: set TMDB_MATCH_APPROVAL to "APPROVE <report SHA-256>" only after reviewing and approving this exact report.');
 if(!backup||!fs.existsSync(backup)||fs.statSync(backup).size<1000)throw Error('A fresh, verified pre-write database backup path is required in TMDB_PREWRITE_BACKUP.');
 const backupHash=crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
 if(process.env.TMDB_PREWRITE_BACKUP_SHA256!==backupHash||process.env.TMDB_PREWRITE_BACKUP_RESTORE_VERIFIED!=='YES')throw Error('Verify a fresh backup by restoring it in isolation, then provide its matching SHA-256 and TMDB_PREWRITE_BACKUP_RESTORE_VERIFIED=YES.');
 if(dups.length||conflicts.length||summary.skipChanged)throw Error('Conflict detected; transaction not started.');
 await prisma.$transaction(async tx=>{
  for(const c of changes){
   if(c.currentTmdbId===c.tmdbId)continue;
   const result=await tx.show.updateMany({where:{id:c.showId,name:c.name,tmdbId:null},data:{tmdbId:c.tmdbId}});
   if(result.count!==1)throw Error(`Show ${c.showId} changed since dry run; rolling back entire transaction.`);
  }
 });
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>prisma.$disconnect());
