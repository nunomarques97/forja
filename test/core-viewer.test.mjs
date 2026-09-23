import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient } from '../viewer/assets/core-client.js';
import { projectState, selectProjects, renderOverview, renderProject, renderLegacyNotice, renderEmptyState } from '../viewer/assets/core.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b}); return { promise, resolve, reject }; };
const snapshot = id => ({ok:true,at:'2026-09-23T12:00:00Z',projects:[],id});
const response = data => ({ok:true,status:200,json:async()=>data});
const setup = (t, options={}) => { const calls=[],states=[],seen=[]; const client=createCoreClient({fetchImpl:(path,opts)=>{const d=deferred();calls.push({path,opts,...d});return d.promise},onSnapshot:d=>seen.push(d),onState:s=>states.push(s),timeoutMs:50,...options});t.after(()=>client.dispose());return {client,calls,states,seen} };

test('Core requests: deadline releases a hung fetch and a hung response body for retry', {timeout:2000}, async t => {
 for (const body of [false,true]) {
  const {client,calls,states,seen}=setup(t);
  const first=client.refresh();
  if(body)calls[0].resolve({ok:true,status:200,json:()=>new Promise(()=>{})});
  await first;
  assert.equal(states.at(-1).kind,'error');assert.match(states.at(-1).message,/took too long/);assert.ok(calls[0].opts.signal.aborted);
  const retry=client.refresh();calls[1].resolve(response(snapshot('fresh')));await retry;
  assert.equal(seen.at(-1).id,'fresh');assert.equal(states.at(-1).kind,'ready');
 }
});
test('Core requests: forced refresh supersedes late success and late failure; polling coalesces', {timeout:1000}, async t=>{
 for(const rejects of [false,true]){
  const {client,calls,seen,states}=setup(t,{timeoutMs:200});
  const old=client.refresh();assert.equal(client.refresh(),old);assert.equal(calls.length,1);
  const fresh=client.refresh({force:true});assert.ok(calls[0].opts.signal.aborted);
  calls[1].resolve(response(snapshot('fresh')));await fresh;
  if(rejects)calls[0].reject(Error('late failure'));else calls[0].resolve(response(snapshot('old')));
  await old;await new Promise(setImmediate);
  assert.deepEqual(seen.map(x=>x.id),['fresh']);assert.equal(states.at(-1).kind,'ready');
 }
});
test('Core requests: a decision invalidates a pending read and blocks polls/duplicate submissions', {timeout:1000}, async t=>{
 const {client,calls,seen}=setup(t,{timeoutMs:200});
 const old=client.refresh(),choice=client.choose({option:'local'});
 assert.equal(calls[1].path,'/api/core/decision');assert.ok(calls[0].opts.signal.aborted);
 assert.equal(await client.refresh({force:true}),null);
 await assert.rejects(client.choose({option:'other'}),/already being saved/);
 calls[1].resolve(response({ok:true,resumed:true}));assert.equal((await choice).resumed,true);
 const after=client.refresh({force:true});calls[2].resolve(response(snapshot('after-choice')));await after;
 calls[0].resolve(response(snapshot('old-decision')));await old;assert.deepEqual(seen.map(x=>x.id),['after-choice']);
});
test('Core requests: failed decision preserves uncertainty and allows an explicit retry', {timeout:1000}, async t=>{
 const {client,calls}=setup(t);
 await assert.rejects(client.choose({option:'local'}),{name:'TimeoutError'});
 const retry=client.choose({option:'local'});calls[1].resolve(response({ok:true,waiting:true}));assert.equal((await retry).waiting,true);
});
test('Core requests: empty snapshots are real data; subsequent errors retain stale state, then recover', {timeout:1000}, async t=>{
 const {client,calls,states,seen}=setup(t,{timeoutMs:200});
 let p=client.refresh();calls[0].resolve(response(snapshot('empty')));await p;
 p=client.refresh();calls[1].reject(Error('offline'));await p;assert.equal(states.at(-1).kind,'stale');assert.equal(seen.length,1);
 p=client.refresh();calls[2].resolve(response(snapshot('recovered')));await p;assert.equal(states.at(-1).kind,'ready');
});
test('Core requests: disposal cancels work without late callbacks; a new lifecycle can start', {timeout:1000}, async t=>{
 const {client,calls,states,seen}=setup(t,{timeoutMs:200});
 const pending=client.refresh();client.dispose();await pending;
 calls[0].resolve(response(snapshot('late')));await new Promise(setImmediate);
 assert.equal(seen.length,0);assert.equal(states.length,1);assert.equal(await client.refresh(),null);
 const fresh=setup(t);const p=fresh.client.refresh();fresh.calls[0].resolve(response(snapshot('new')));await p;assert.equal(fresh.seen.length,1);
});
test('Core requests: unauthorized and malformed responses produce visible errors', {timeout:1000}, async t=>{
 const {client,calls,states}=setup(t);
 let p=client.refresh();calls[0].resolve({status:401});await p;assert.match(states.at(-1).message,/Session expired/);
 p=client.refresh();calls[1].resolve(response({ok:true}));await p;assert.match(states.at(-1).message,/incomplete/);
});
const project=(name,status,alive=true)=>({name,core:{run:{run_id:'F-test',status,goal:'Objetivo '+name,provider:'codex',updated_at:'2026-09-23'},runnerAlive:alive,invocations:0,tasks:[],technology:[],usage:{rows:[],totals:{invocations:0,input_covered_invocations:0}}}});
test('Core overview prioritizes attention, separates interrupted runs, and filters without fabricating history',()=>{
 const rows=[project('Final','done'),project('Ativo','running'),project('Parado','running',false),project('Bloqueado','blocked')];
 assert.equal(projectState(rows[2]).label,'Interrupted');assert.equal(projectState(rows[2]).group,'attention');
 assert.deepEqual(selectProjects(rows).map(p=>p.name),['Bloqueado','Parado','Ativo','Final']);
 assert.deepEqual(selectProjects(rows,'attention','parado').map(p=>p.name),['Parado']);
 assert.equal(selectProjects(rows,'done').length,1);assert.match(renderOverview(rows),/Needs attention/);
 const html=renderProject(project('<script>alert(1)</script>','running',false));
 assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/No active process/);assert.match(html,/data-section="sessions"/);assert.doesNotMatch(html,/<details[^>]*\bopen\b/);
});
test('Legacy-only discovery is safe, pluralized, and distinct from Core and filter empty states',()=>{
 assert.equal(renderLegacyNotice(undefined),'');
 assert.equal(renderLegacyNotice(-1),'');
 assert.equal(renderLegacyNotice(1.5),'');
 assert.equal(renderLegacyNotice(Number.MAX_SAFE_INTEGER + 1),'');
 assert.equal(renderLegacyNotice('<img src=x onerror=alert(1)>'),'');
 assert.match(renderLegacyNotice(1),/1 registered project has no Core run/);
 assert.match(renderLegacyNotice(1),/href="\/legacy"/);
 assert.match(renderLegacyNotice(2),/2 registered projects have no Core run/);
 assert.doesNotMatch(renderLegacyNotice(2),/<img|onerror/);
 assert.match(renderEmptyState(0,undefined),/It starts with a goal/);
 assert.match(renderEmptyState(0,'2'),/It starts with a goal/);
 assert.match(renderEmptyState(0,2),/No Core runs yet/);
 assert.match(renderEmptyState(1,2),/No projects in this view/);
});
