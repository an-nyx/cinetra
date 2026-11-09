import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '../src/database/prisma';
import { getLibraryTracking } from '../src/services/episode-guide.service';

async function main(){
 const users=await prisma.user.findMany({select:{id:true}});
 const results:any[]=[];
 for(const user of users){
  const tracking=await getLibraryTracking(user.id);
  const shows=await prisma.show.findMany({where:{userId:user.id},select:{id:true,tmdbId:true,seasonsWatched:true,episodesWatched:true,status:true,completed:true}});
  const byId=new Map(shows.map(s=>[s.id,s]));
  for(const raw of tracking){const item:any=raw;const show=byId.get(item.showId);if(!show)continue;results.push({showId:item.showId,tmdbId:show.tmdbId,legacy:`S${show.seasonsWatched}E${show.episodesWatched}`,broadcastStatus:item.broadcastStatus||'unknown',viewingState:item.viewingState||'unknown',personalStatus:show.status||(show.completed?'completed':'unset'),completionEligible:item.completionEligible||false,proposedPersonalStatus:null,reason:item.error||(!show.tmdbId?'TMDB association missing; not classified.':item.completionEligible?'Completion evidence detected; personal status awaits separate approval.':'Insufficient evidence to propose a change.')});}
 }
 const report={createdAt:new Date().toISOString(),readOnly:true,totalShows:results.length,showsWithTmdbId:results.filter(x=>x.tmdbId).length,showsWithoutTmdbId:results.filter(x=>!x.tmdbId).length,classificationCounts:results.reduce((a,x)=>(a[x.viewingState]=(a[x.viewingState]||0)+1,a),{} as Record<string,number>),eligibleForCompleted:results.filter(x=>x.completionEligible).map(({showId,name,tmdbId,legacy,broadcastStatus,viewingState,personalStatus})=>({showId,name,tmdbId,legacy,broadcastStatus,viewingState,personalStatus,proposedPersonalStatus:'completed'})),writesExecuted:0,rows:results};
 fs.writeFileSync('docs/completion-dry-run.json',JSON.stringify(report,null,2));console.log(JSON.stringify({total:report.totalShows,withTmdb:report.showsWithTmdbId,withoutTmdb:report.showsWithoutTmdbId,states:report.classificationCounts,eligible:report.eligibleForCompleted.length,writes:0}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>prisma.$disconnect());
