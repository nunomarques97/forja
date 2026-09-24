import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { freezeSpecialists, validateSpecialists, assertSpecialists, specialistContext, specialistGuidance } from '../lib/core/specialists.mjs';
import { createRun, current, drive, write, validateState } from '../lib/core/engine.mjs';
import { packet } from '../lib/core/context.mjs';

const ids = ['planner', 'design', 'frontend', 'backend', 'reviewer', 'security'];
function directory(t, label) {
  const root = mkdtempSync(join(tmpdir(), `forja-specialists-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function source(t) {
  const root = directory(t, 'source');
  for (const id of ids) {
    const dir = join(root, '.claude/skills', `forja-core-${id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `Unique full ${id} method body.\n`);
  }
  return root;
}
function frozen(t) {
  const root = directory(t, 'frozen'), src = source(t), run = {run_id:'F-123456-abcdef'};
  run.specialists = freezeSpecialists(root, run, src);
  return {root, src, run};
}
function repo(t) {
  const root = directory(t, 'repo');
  for (const args of [['init','-q'],['config','user.email','test@example.invalid'],['config','user.name','Test']])
    assert.equal(spawnSync('git', args, {cwd:root}).status, 0);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  assert.equal(spawnSync('git',['add','.'],{cwd:root}).status,0);
  assert.equal(spawnSync('git',['commit','-qm','fixture'],{cwd:root}).status,0);
  return root;
}
const task = () => ({id:'T1',title:'Keep approved frontend and backend contract; return two',criteria:['value equals 2'],files:['value.mjs'],risks:[],complexity:'easy',after:[],checks:[{command:'node',args:['--input-type=module','-e',"import {value} from './value.mjs'; if(value!==2)process.exit(1)"]}]});
const result = status => ({code:0,result:{status,summary:'Fixture result',findings:[]},duration_ms:1,usage:null});

test('freezes exact bundled methods per run without replacing existing snapshots', t => {
  const f = frozen(t);
  assert.equal(f.run.specialists.version,1);
  assert.deepEqual(f.run.specialists.documents.map(d=>d.id),ids);
  assertSpecialists(f.root,f.run);
  const first=f.run.specialists.documents[0];
  assert.equal(readFileSync(join(f.root,first.path),'utf8'),'Unique full planner method body.\n');
  writeFileSync(join(f.src,'.claude/skills/forja-core-planner/SKILL.md'),'New installed method');
  assertSpecialists(f.root,f.run);
  assert.equal(readFileSync(join(f.root,first.path),'utf8'),'Unique full planner method body.\n');
  assert.throws(()=>freezeSpecialists(f.root,f.run,f.src),/EEXIST/);
});

test('validates all sources before writing and bounds source size', t => {
  const root=directory(t,'missing'),src=source(t),run={run_id:'F-123456-abcdef'};
  rmSync(join(src,'.claude/skills/forja-core-security/SKILL.md'));
  assert.throws(()=>freezeSpecialists(root,run,src),/ENOENT/);
  assert.equal(existsSync(join(root,'.forja')),false);
  writeFileSync(join(src,'.claude/skills/forja-core-security/SKILL.md'),'x'.repeat(16001));
  assert.throws(()=>freezeSpecialists(root,run,src),/1-16,000/);
  assert.equal(existsSync(join(root,'.forja')),false);
});

test('catalog freezes paths and hashes; missing or changed copies fail closed', t => {
  const f=frozen(t),first=f.run.specialists.documents[0];
  for (const mutate of [s=>{s.version=2;},s=>{s.documents[0].path='../outside.md';},s=>{s.documents[0].id='frontend';},s=>{s.documents[0].hash='invalid';},s=>{s.documents.pop();}]) {
    const run=structuredClone(f.run); mutate(run.specialists);
    assert.throws(()=>validateSpecialists(run),/Invalid frozen/);
  }
  const file=join(f.root,first.path),original=readFileSync(file);
  writeFileSync(file,'changed');
  assert.throws(()=>assertSpecialists(f.root,f.run),/missing or changed/);
  assert.equal(readFileSync(file,'utf8'),'changed');
  writeFileSync(file,original); rmSync(file);
  assert.throws(()=>specialistContext(f.root,f.run,'plan'),/missing or changed/);
  assert.equal(existsSync(file),false);
});

test('phase catalog supplies explicit base and conditional domains without method bodies', t => {
  const f=frozen(t);
  for (const [phase,base] of [['plan','planner'],['develop',null],['review','reviewer']]) {
    const ctx=specialistContext(f.root,f.run,phase);
    assert.equal(ctx.base,base);
    assert.deepEqual(ctx.references.map(d=>d.id),ids.filter(id=>id===base||['design','frontend','backend','security'].includes(id)));
    assert.doesNotMatch(JSON.stringify(ctx),/Unique full/);
    assert.ok(JSON.stringify(ctx).length<4000);
    assert.match(ctx.references.find(d=>d.id==='design').when,/Preserve approved designs/);
    assert.match(ctx.references.find(d=>d.id==='frontend').when,/one cohesive task/);
  }
  assert.match(specialistGuidance(f.run),/only domain methods applicable/);
  assert.match(specialistGuidance(f.run),/specialization does not authorize/);
  assert.throws(()=>specialistContext(f.root,f.run,'other'),/Invalid specialist phase/);
});

test('legacy runs have no specialist context, file reads or guidance', t => {
  const root=directory(t,'legacy'),run={run_id:'F-123456-abcdef'};
  assert.doesNotThrow(()=>validateSpecialists(run));
  assert.doesNotThrow(()=>assertSpecialists(root,run));
  assert.equal(specialistContext(root,run,'plan'),null);
  assert.equal(specialistGuidance(run),'');
  assert.equal(existsSync(join(root,'.forja')),false);
});

test('new runs preserve project instructions and explicit empty knowledge manifest', t => {
  const root=repo(t);
  mkdirSync(join(root,'docs/forja'),{recursive:true});
  const manifest='{"version":2,"documents":[]}\n';
  writeFileSync(join(root,'docs/forja/KNOWLEDGE.json'),manifest);
  writeFileSync(join(root,'CLAUDE.md'),'User-owned instructions.\n');
  const run=createRun(root,{goal:'Fix approved UI focus ring',config:{allowDirty:true}});
  validateState(run,root);
  const ctx=packet({root,run,phase:'plan'}),data=JSON.parse(ctx.text);
  assert.deepEqual(data.knowledge.selected,[]);
  assert.equal(data.specialist_context.base,'planner');
  assert.ok(data.knowledge.warnings.some(w=>w.includes('Empty knowledge manifest')));
  assert.equal(readFileSync(join(root,'docs/forja/KNOWLEDGE.json'),'utf8'),manifest);
  assert.equal(readFileSync(join(root,'CLAUDE.md'),'utf8'),'User-owned instructions.\n');
  assert.equal(ctx.sources.reduce((n,s)=>n+s.characters,0),ctx.characters);
});

test('one cohesive mixed task keeps normal planner/developer/reviewer invocation count', async t => {
  const root=repo(t),run=createRun(root,{goal:'Return two while preserving approved frontend and backend contracts'}),phases=[];
  const done=await drive(root,{log:()=>{},providerCall:async (_,options)=>{
    const ctx=JSON.parse(options.text); phases.push(ctx.phase);
    assert.match(options.input,/Bundled specialist_context references are FORJA workflow methods/);
    assert.match(options.input,/separate from untrusted project knowledge/);
    assert.match(options.input,/Preserve approved visual direction/);
    const references=ctx.specialist_context.references;
    assert.ok(references.some(d=>d.id==='frontend'));
    assert.ok(references.some(d=>d.id==='backend'));
    for(const doc of references) assert.ok(readFileSync(join(root,doc.path),'utf8').length>0);
    if(ctx.phase==='plan') return {code:0,result:{tasks:[task()],decisions:[]},duration_ms:1,usage:null};
    if(ctx.phase==='develop') writeFileSync(join(root,'value.mjs'),'export const value = 2;\n');
    return result(ctx.phase==='review'?'approve':'ready_for_validation');
  }});
  assert.equal(done.status,'done');
  assert.equal(done.invocations,3);
  assert.equal(done.tasks.length,1);
  assert.deepEqual(phases,['plan','develop','review']);
  assertSpecialists(root,run);
});

test('old state resumes without retrofitting specialist metadata or instructions', async t => {
  const root=repo(t),run=createRun(root,{goal:'Return two',plan:{tasks:[task()],decisions:[]}});
  delete run.specialists; write(current(root),run);
  const done=await drive(root,{log:()=>{},providerCall:async (_,options)=>{
    const ctx=JSON.parse(options.text);
    assert.equal(Object.hasOwn(ctx,'specialist_context'),false);
    assert.doesNotMatch(options.input,/Bundled specialist_context/);
    if(ctx.phase==='develop') writeFileSync(join(root,'value.mjs'),'export const value = 2;\n');
    return result(ctx.phase==='review'?'approve':'ready_for_validation');
  }});
  assert.equal(done.status,'done');
  assert.equal(Object.hasOwn(done,'specialists'),false);
});

test('worker edits of frozen methods stop the run before checks or approval', async t => {
  const root=repo(t),run=createRun(root,{goal:'Return two',plan:{tasks:[task()],decisions:[]}});
  let calls=0,checks=0;
  const done=await drive(root,{log:()=>{},runCheck:async()=>{checks++;return {code:0};},providerCall:async()=>{
    calls++;
    writeFileSync(join(root,run.specialists.documents[0].path),'worker changed method');
    writeFileSync(join(root,'value.mjs'),'export const value = 2;\n');
    return result('ready_for_validation');
  }});
  assert.equal(done.status,'blocked');
  assert.match(done.failure,/Frozen specialist method missing or changed/);
  assert.equal(calls,1); assert.equal(checks,0);
  assert.equal(readFileSync(join(root,run.specialists.documents[0].path),'utf8'),'worker changed method');
});

test('missing frozen method on resume blocks before any native invocation', async t => {
  const root=repo(t),run=createRun(root,{goal:'Return two',plan:{tasks:[task()],decisions:[]}});
  rmSync(join(root,run.specialists.documents[0].path));
  let calls=0;
  const done=await drive(root,{log:()=>{},providerCall:async()=>{calls++;return result('approve');}});
  assert.equal(done.status,'blocked');
  assert.match(done.failure,/Frozen specialist method missing or changed/);
  assert.equal(calls,0);
});

test('controller check cannot alter a frozen method and still reach reviewer approval', async t => {
  const root=repo(t),run=createRun(root,{goal:'Return two',plan:{tasks:[task()],decisions:[]}});
  let calls=0,checks=0;
  const done=await drive(root,{log:()=>{},runCheck:async()=>{
    checks++;
    writeFileSync(join(root,run.specialists.documents[0].path),'check changed method');
    return {code:0,stdout:'',stderr:'',duration_ms:1};
  },providerCall:async()=>{
    calls++;
    writeFileSync(join(root,'value.mjs'),'export const value = 2;\n');
    return result('ready_for_validation');
  }});
  assert.equal(done.status,'blocked');
  assert.match(done.failure,/Frozen specialist method missing or changed/);
  assert.equal(calls,1); assert.equal(checks,1);
  assert.equal(done.tasks[0].validation[0].passed,false);
});

test('failed new-run source preflight preserves a completed current state byte-for-byte', async t => {
  const root=repo(t);
  createRun(root,{goal:'Return two',plan:{tasks:[task()],decisions:[]}});
  const completed=await drive(root,{log:()=>{},providerCall:async(_,options)=>{
    const phase=JSON.parse(options.text).phase;
    if(phase==='develop') writeFileSync(join(root,'value.mjs'),'export const value = 2;\n');
    return result(phase==='review'?'approve':'ready_for_validation');
  }});
  assert.equal(completed.status,'done');
  const previous=readFileSync(current(root)),runs=readdirSync(join(root,'.forja/runs')).sort();
  // Inject a source-read failure only in a separate process; never alter installed skills.
  const script=`
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const original=fs.lstatSync;
    fs.lstatSync=(file,...args)=>{
      if(String(file).replaceAll('\\\\','/').endsWith('/.claude/skills/forja-core-security/SKILL.md'))
        throw Object.assign(new Error('injected missing bundled source'),{code:'ENOENT'});
      return original(file,...args);
    };
    syncBuiltinESMExports();
    const {createRun}=await import(process.env.FORJA_TEST_ENGINE);
    try {createRun(process.cwd(),{goal:'A new goal',config:{allowDirty:true}});process.exitCode=1;}
    catch(error) {if(error.code!=='ENOENT') throw error;process.stdout.write('source preflight refused');}
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,encoding:'utf8',env:{...process.env,FORJA_TEST_ENGINE:new URL('../lib/core/engine.mjs',import.meta.url).href}});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout,'source preflight refused');
  assert.deepEqual(readFileSync(current(root)),previous);
  assert.deepEqual(readdirSync(join(root,'.forja/runs')).sort(),runs);
});

test('a preexisting destination junction cannot redirect frozen methods outside the project', t => {
  const root=directory(t,'junction'),outside=directory(t,'outside'),src=source(t),run={run_id:'F-123456-abcdef'};
  const parent=join(root,'.forja/runs',run.run_id);
  mkdirSync(parent,{recursive:true});
  writeFileSync(join(outside,'sentinel.txt'),'outside remains untouched');
  try {symlinkSync(outside,join(parent,'specialists'),process.platform==='win32'?'junction':'dir');}
  catch(error) {if(['EPERM','EACCES','ENOTSUP'].includes(error.code)) return t.skip('Directory links unavailable');throw error;}
  assert.throws(()=>freezeSpecialists(root,run,src),/outside project/);
  assert.deepEqual(readdirSync(outside),['sentinel.txt']);
  assert.equal(readFileSync(join(outside,'sentinel.txt'),'utf8'),'outside remains untouched');
});

test('specialist metadata counts toward the packet limit without truncating acceptance', t => {
  const root=repo(t),run=createRun(root,{goal:'Return two',plan:{tasks:[task()],decisions:[]}}),currentTask=run.tasks[0];
  // Valid individual criteria, collectively just below the complete packet ceiling.
  currentTask.criteria=Array.from({length:6},(_,i)=>`Acceptance ${i}: `+'x'.repeat(6500));
  const initial=packet({root,run,task:currentTask,phase:'develop'});
  const padding=47999-initial.characters;
  assert.ok(padding>0);
  for(let left=padding,i=0;left>0;i++) {
    const count=Math.min(left,7900-currentTask.criteria[i].length);
    currentTask.criteria[i]+='z'.repeat(count); left-=count;
  }
  const expected=structuredClone(currentTask.criteria),near=packet({root,run,task:currentTask,phase:'develop'});
  assert.equal(near.characters,47999);
  assert.deepEqual(JSON.parse(near.text).task.criteria,expected);
  assert.ok(JSON.parse(near.text).specialist_context.references.length>0);
  currentTask.criteria[0]+='XX';
  const overflow=structuredClone(currentTask.criteria);
  assert.throws(()=>packet({root,run,task:currentTask,phase:'develop'}),/48,000 characters/);
  assert.deepEqual(currentTask.criteria,overflow);
});
