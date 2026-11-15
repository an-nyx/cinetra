import assert from 'node:assert/strict';
import { statusScope, scopedTarget, scopeDigest } from '../src/services/show-status-scope.model';
const show = { id: 'approved', userId: 'owner', tmdbId: 1, tvmazeId: null };
delete process.env.TV_STATUS_RECONCILIATION_SCOPE;
assert.equal(statusScope(), null);
for (const value of ['broken', '{}', '{"userId":"owner","targets":[],"excludedShowIds":[]}']) {
  process.env.TV_STATUS_RECONCILIATION_SCOPE = value; assert.equal(statusScope(), null);
}
const config = { userId: 'owner', targets: [{ showId: 'approved', tmdbId: 1, tvmazeId: 2 }], excludedShowIds: ['legacy', 'unverifiable'] };
process.env.TV_STATUS_RECONCILIATION_SCOPE = JSON.stringify(config);
assert.ok(scopedTarget(show)); assert.ok(scopeDigest());
for (const changed of [{...show, id:'legacy'}, {...show, id:'other'}, {...show,userId:'another'}, {...show,tmdbId:3}, {...show,tvmazeId:4}]) assert.equal(scopedTarget(changed),null);
process.env.TV_STATUS_RECONCILIATION_SCOPE = JSON.stringify({...config, excludedShowIds:['approved']}); assert.equal(statusScope(),null);
process.env.TV_STATUS_RECONCILIATION_SCOPE = JSON.stringify({...config, targets:[...config.targets,...config.targets]}); assert.equal(statusScope(),null);
console.log('Explicit status scope tests passed');
