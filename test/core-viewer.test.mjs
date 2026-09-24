import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const region=html=>html.match(/<section class="validation-evidence"[\s\S]*?<\/section>/)?.[0];
const withSummary=(summary,name='Example')=>{const p=project(name,'done');if(summary!==undefined)p.core.validation_summary=summary;return p;};
test('Validation evidence shows labelled latest counts outside collapsed details',()=>{
 const html=renderProject(withSummary({passed:3,failed:1,unknown:2,tasks_without_records:1234}));
 const r=region(html);assert.ok(r);
 assert.match(r,/<h4>Validation evidence<\/h4>/);
 assert.match(r,/<dt>passed<\/dt><dd>3<\/dd>/);assert.match(r,/<dt>failed<\/dt><dd>1<\/dd>/);
 assert.match(r,/<dt>unknown<\/dt><dd>2<\/dd>/);assert.match(r,/<dt>tasks without records<\/dt><dd>1,234<\/dd>/);
 assert.match(r,/latest checks/i);assert.match(r,/not release approval or a history/);
 assert.match(r,/aria-label="Validation evidence for Example"/);
 assert.doesNotMatch(r,/tabindex|\bid=|<details|<button|<a |<input/);assert.doesNotMatch(r,/unavailable/);
 assert.ok(html.indexOf('class="validation-evidence"')<html.indexOf('<details'));
 assert.doesNotMatch(html,/<details[^>]*\bopen\b/);
 assert.match(r,/class="failed has-failures"/);
});
test('Validation evidence renders a valid all-zero summary as zeros',()=>{
 const r=region(renderProject(withSummary({passed:0,failed:0,unknown:0,tasks_without_records:0})));
 for(const label of ['passed','failed','unknown','tasks without records'])assert.match(r,new RegExp(`<dt>${label}</dt><dd>0</dd>`));
 assert.doesNotMatch(r,/unavailable|has-failures/);
});
test('Validation evidence treats missing or invalid summaries from older servers as unavailable',()=>{
 const valid={passed:0,failed:0,unknown:0,tasks_without_records:0};
 const variants=[undefined,null,[],Object.assign([],valid),{},'summary',5,
  {...valid,passed:-1},{...valid,failed:1.5},{...valid,unknown:'1'},{...valid,tasks_without_records:Number.MAX_SAFE_INTEGER+1},
  {...valid,passed:NaN},{...valid,failed:Infinity},{...valid,unknown:null},{passed:0,failed:0,unknown:0},
  {...valid,passed:'<img src=x onerror=alert(1)>'},{...valid,tasks_without_records:{toString:()=>'<img src=x>'}},Object.create(valid)];
 for(const summary of variants){
  const html=renderProject(withSummary(summary,'<img src=x onerror=alert(2)>')),r=region(html);
  assert.ok(r,JSON.stringify(summary));
  assert.match(r,/Validation evidence unavailable/);
  assert.doesNotMatch(r,/<dl|<dd|<dt|all passed|0 failed|latest checks/i);
  assert.ok(!html.includes('<img'),JSON.stringify(summary));
 }
});
test('Validation evidence is absent from error cards',()=>{
 const html=renderProject({name:'Broken',core:{run:null,runnerAlive:true,error:'Core state is unreadable; check locally before recovering.',validation_summary:{passed:1,failed:0,unknown:0,tasks_without_records:0}}});
 assert.doesNotMatch(html,/Validation evidence|validation-evidence/);assert.match(html,/Status unavailable/);
});
test('Validation evidence styles extend the card tokens and wrap to two columns on narrow screens',()=>{
 const css=readFileSync(new URL('../viewer/assets/core.css',import.meta.url),'utf8');
 const rules=css.match(/\.validation-[^{]*\{[^}]*\}/g)||[];assert.ok(rules.length>0);
 assert.ok(rules.every(rule=>!/text-transform/.test(rule)));
 assert.match(css,/\.validation-counts \{\s*display:grid;\s*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
 const narrow=css.slice(css.indexOf('@media(max-width:540px)'));
 assert.match(narrow,/\.validation-counts \{\s*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
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
