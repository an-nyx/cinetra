import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/database/prisma';
import { getLibraryTracking } from '../src/services/episode-guide.service';

async function main(){
 const users=await prisma.user.findMany({select:{id:true}});
 const results:any[]=[];
 for(const user of users){
  const tracking=await getLibraryTracking(user.id);
 const shows=await prisma.show.findMany({where:{userId:user.id},select:{id:true,name:true,tmdbId:true,seasonsWatched:true,episodesWatched:true,status:true,completed:true}});
  const byId=new Map(shows.map(s=>[s.id,s]));
  for(const raw of tracking){const item:any=raw;const show=byId.get(item.showId);if(!show)continue;const personalStatus=show.status||(show.completed?'completed':'unset');results.push({showId:item.showId,name:show.name,tmdbId:show.tmdbId,legacy:{season:show.seasonsWatched,episode:show.episodesWatched},broadcastStatus:item.broadcastStatus||'unknown',viewingState:item.viewingState||'unknown',personalStatus,completionEligible:item.completionEligible||false,proposedPersonalStatus:null,reason:item.error||item.metadataError||(!show.tmdbId?'TMDB association missing; not classified.':item.completionEligible?'Completion evidence detected; personal status awaits separate approval.':'Insufficient evidence to propose a change.'),evidence:item.error||item.metadataError?null:{finalSeason:item.finalSeason,finalityConfirmed:item.finalityConfirmed,progressPercent:item.progressPercent,watchedCount:item.watchedCount,releasedCount:item.releasedCount,legacyPosition:item.legacyPosition,nextEpisode:item.nextEpisode?{season:item.nextEpisode.season,episode:item.nextEpisode.number}:null}});}
 }
 const eligible=results.filter(x=>x.completionEligible);
 const statusChanges=eligible.filter(x=>x.personalStatus!=='completed').map(x=>({showId:x.showId,name:x.name,tmdbId:x.tmdbId,legacy:x.legacy,broadcastStatus:x.broadcastStatus,viewingState:x.viewingState,evidence:x.evidence,proposedPersonalStatus:'completed'}));
 const detailed={createdAt:new Date().toISOString(),readOnly:true,totalShows:results.length,showsWithTmdbId:results.filter(x=>x.tmdbId).length,showsWithoutTmdbId:results.filter(x=>!x.tmdbId).length,classificationCounts:results.reduce((a,x)=>(a[x.viewingState]=(a[x.viewingState]||0)+1,a),{} as Record<string,number>),eligibleForCompleted:eligible.map(({showId,name,tmdbId,legacy,broadcastStatus,viewingState,personalStatus,evidence})=>({showId,name,tmdbId,legacy,broadcastStatus,viewingState,personalStatus,proposedPersonalStatus:personalStatus==='completed'?null:'completed',evidence})),proposedStatusChanges:statusChanges,writesExecuted:0,rows:results};
 const summary={createdAt:detailed.createdAt,readOnly:true,totalShows:detailed.totalShows,showsWithTmdbId:detailed.showsWithTmdbId,showsWithoutTmdbId:detailed.showsWithoutTmdbId,classificationCounts:detailed.classificationCounts,metadataLookupFailures:results.filter(x=>x.tmdbId&&x.reason?.startsWith('Request failed')).length,eligibleForCompleted:eligible.length,proposedStatusChanges:statusChanges.length,writesExecuted:0,detailsStoredLocally:true};
 const privateReportPath=process.env.CINETRA_PRIVATE_REPORT || path.join(os.tmpdir(),'cinetra-completion-dry-run.private.json');
 fs.writeFileSync(privateReportPath,JSON.stringify(detailed,null,2));
 fs.writeFileSync(path.resolve(__dirname,'../../docs/completion-dry-run.json'),JSON.stringify(summary,null,2));
 console.log(JSON.stringify({...summary,privateReportPath}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>prisma.$disconnect());
