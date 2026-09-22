import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobState, maxJobAgeSeconds } from '../src/job-freshness.js';
const now = 2000000000;
test('monthly 13F history stays healthy between monthly runs', () => {
  const job = {id:'fetch-13f-history', lastRun:{ts:now-21*86400,status:'ok'}};
  assert.equal(jobState(job, now), 'ok');
  assert.equal(maxJobAgeSeconds(job.id), 35*86400);
  assert.equal(jobState({...job,lastRun:{ts:now-36*86400,status:'ok'}}, now), 'stale');
});
test('daily stale runs, real failures, pending and disabled jobs remain distinct', () => {
  assert.equal(jobState({id:'daily',lastRun:{ts:now-49*3600,status:'ok'}}, now), 'stale');
  assert.equal(jobState({id:'fetch-13f-history',lastRun:{ts:now,status:'failed'}}, now), 'failed');
  assert.equal(jobState({id:'daily'}, now), 'pending');
  assert.equal(jobState({id:'daily',cronDisabled:true}, now), 'manual');
});
