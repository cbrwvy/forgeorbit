import { HIRING_PROPOSAL_LIMITS } from '../../shared/hiring/types.ts';
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate } from '../migrate.ts';
import { migrations as registry } from '../migrations/index.ts';
const migrations = registry.filter(m => m.id.slice(0, 3) <= '089');
import { hiringProposalHttp } from './hiring-proposal-http.ts';
import { HiringProposalCore } from './hiring-proposal-core.ts';
import { EmployeeProfileCore } from './employee-profile-core.ts';
import { RoleCatalogService } from './role-catalog.ts';
const prep = '088a_legacy_hiring_compatibility';
const old = migrations.filter(m => m.id < '088a');
const historical = migrations.filter(m => m.id !== prep);
const role = 'engineering-frontend-developer';
const catalog = new RoleCatalogService();
function seed(db: Database, status: string, message: string | null, at: number) {
  const id = randomUUID();
  db.run(`INSERT INTO hiring_proposals (id,project_path,proposed_name,professional_title,catalog_role_slug,template_sha256,prompt_markdown,justification,proposed_by_kind,source_message_id,status,created_at,updated_at,decided_at,created_employee_id,decision_note,stale_reason)
    VALUES (?, '/work/project', ?, 'Developer', ?, ?, ?, ?, 'project-manager', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `Name ${at}`, role, catalog.getRole(role).sha256, `Unique prompt ${at} Ж`, `Reason ${at}`, message, status, at, at,
      status === 'pending' ? null : at + 100, status === 'approved' ? 'a0000000-0000-4000-8000-000000000001' : null,
      status === 'pending' ? null : `Owner decision ${at}`, status === 'stale' ? `Old stale ${at}` : null]);
  db.run(`INSERT INTO hiring_proposal_events (proposal_id,project_path,action,actor,proposal_revision,note,created_at) VALUES (?, '/work/project', 'created', 'project-manager', 1, ?, ?)`, [id, `Audit ${at}`, at]);
  return id;
}
function rows(db: Database) { return db.query<Record<string, any>, []>('SELECT * FROM hiring_proposals ORDER BY id').all(); }
function checks(db: Database) {
  expect(db.query('PRAGMA integrity_check').all()).toEqual([{integrity_check:'ok'}]);
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({n:0});
}
for (const mode of ['pending', 'source', 'combined']) {
 test(`legacy ${mode}: snapshots, decisions, provenance, APIs, replay, reopen and constraints`, async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'mig089-'));const file=path.join(dir,'test.sqlite');let db=new Database(file);
  try {
    db.run('PRAGMA journal_mode=WAL');db.run('PRAGMA foreign_keys=ON');migrate(db,old);
    db.run("INSERT INTO projects(path,name,added_at) VALUES('/work/project','Legacy',1)");
    db.run(`INSERT INTO ai_employees(id,kind,name,name_source,job_title,role_category,specializations,status,created_at,updated_at) VALUES('a0000000-0000-4000-8000-000000000001','worker','Existing','owner','Dev','engineering','[]','active',1,1)`);
    new EmployeeProfileCore(db).assignRole('a0000000-0000-4000-8000-000000000001',{catalogRoleSlug:role});
    if(mode!=='source') {seed(db,'pending','pending-1',10);seed(db,'pending',mode==='combined'?'same':'pending-2',20);seed(db,'pending','third',30);}
    if(mode!=='pending') for(const [i,status] of ['approved','rejected','withdrawn','stale'].entries()) seed(db,status,'same',i+40);
    const before=rows(db);const events=db.query('SELECT * FROM hiring_proposal_events ORDER BY id').all();
    const currentProfiles=db.query('SELECT * FROM ai_employee_professional_profiles').all();
    const employee=db.query('SELECT * FROM ai_employees').all();const profile=db.query('SELECT * FROM ai_employee_profile_revisions').all();
    expect(migrate(db,migrations)).toEqual([prep,'089_hiring_proposal_dedup']);
    const after=rows(db);expect(after.map(r=>r.id)).toEqual(before.map(r=>r.id));
    for(const original of before) {
      const record=db.query<any, [string]>('SELECT * FROM hiring_legacy_provenance WHERE proposal_id=?').get(original.id);
      const current=after.find(r=>r.id===original.id)!;
      if(record) {expect(JSON.parse(record.original_row_json)).toEqual(original);expect(JSON.parse(record.original_events_json)).toEqual(events.filter((e:any)=>e.proposal_id===original.id));}
      for(const key of Object.keys(original).filter(k=>!['status','stale_reason','revision','decided_at','updated_at','source_message_id'].includes(k))) expect(current[key]).toEqual(original[key]);
      if(original.status!=='pending') {expect(current.status).toBe(original.status);expect(current.decided_at).toBe(original.decided_at);expect(current.revision).toBe(original.revision);}
      const exposed=new HiringProposalCore(db).requireProposal(original.id);
      expect(exposed.sourceMessageId).toBe(original.source_message_id);
      expect(exposed.promptMarkdown).toBe(original.prompt_markdown);
      const response = await hiringProposalHttp(new Request(`http://localhost/hiring-proposals/${original.id}`), true, {core:new HiringProposalCore(db)});
      expect(response.status).toBe(200);
      const body=await response.json(); expect(body.proposal.sourceMessageId).toBe(original.source_message_id);
      if(record) expect(body.proposal.legacyNormalization.originalProposal).toEqual(original);
    }
    expect(db.query('SELECT * FROM hiring_proposal_events ORDER BY id').all().slice(0,events.length)).toEqual(events);
    expect(db.query('SELECT * FROM ai_employee_professional_profiles').all()).toEqual(currentProfiles);
    expect(db.query('SELECT * FROM ai_employees').all()).toEqual(employee);expect(db.query('SELECT * FROM ai_employee_profile_revisions').all()).toEqual(profile);
    if(mode!=='source') {expect(after.filter(r=>r.status==='pending')).toHaveLength(1);expect(after.filter(r=>r.status==='pending')[0]!.created_at).toBe(10);expect(()=>seed(db,'pending','new',99)).toThrow(/UNIQUE/);}
    if(mode!=='pending') {
      expect(()=>seed(db,'rejected','same',999)).toThrow(/UNIQUE/);
      const canonical=after.find(r=>r.source_message_id==='same')!;
      const result=new HiringProposalCore(db).createFromManager('/work/project',[{roleSlug:role,justification:'Replay'}],{messageId:'same'});
      expect(result.created.map(r=>r.id)).toEqual([canonical.id]);expect(rows(db)).toEqual(after);
    }
    expect(()=>db.run("UPDATE hiring_legacy_provenance SET reason='changed'")).toThrow(/immutable/);
    expect(()=>db.run('DELETE FROM hiring_legacy_provenance')).toThrow(/immutable/);
    expect(()=>db.run('INSERT OR REPLACE INTO hiring_legacy_provenance SELECT * FROM hiring_legacy_provenance')).toThrow(/immutable/);
    checks(db);db.close();db=new Database(file);db.run('PRAGMA foreign_keys=ON');
    expect(migrate(db,migrations)).toEqual([]);expect(rows(db)).toEqual(after);checks(db);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
 });
}

test('injected 089 failure rolls back normalization, audit, provenance, both ledgers and indexes; retry succeeds',()=>{
 const db=new Database(':memory:');try{
  migrate(db,old);seed(db,'pending','message',1);seed(db,'pending','message',2);
  const before=rows(db);const events=db.query('SELECT * FROM hiring_proposal_events').all();const ledger=db.query('SELECT * FROM _migrations').all();
  const broken=migrations.map(m=>m.id==='089_hiring_proposal_dedup'?{...m,sql:m.sql+'; INSERT INTO missing_fault_injection VALUES (1)'}:m);
  expect(()=>migrate(db,broken)).toThrow();expect(rows(db)).toEqual(before);
  expect(db.query('SELECT * FROM hiring_proposal_events').all()).toEqual(events);expect(db.query('SELECT * FROM _migrations').all()).toEqual(ledger);
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('hiring_legacy_provenance','idx_hiring_proposals_pending_role','idx_hiring_proposals_pm_replay')").all()).toEqual([]);
  expect(migrate(db,migrations)).toEqual([prep,'089_hiring_proposal_dedup']);checks(db);
 }finally{db.close();}
});
test('already-089 database gains empty provenance schema and retains all rows and indexes',()=>{
 const db=new Database(':memory:');try{migrate(db,historical);seed(db,'rejected','old-message',1);const before=rows(db);
 expect(migrate(db,migrations)).toEqual([prep]);expect(rows(db)).toEqual(before);expect(migrate(db,migrations)).toEqual([]);checks(db);
 }finally{db.close();}
});
test('two connections: writer contention leaves legacy data untouched and supports retry',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'mig089-lock-'));const file=path.join(dir,'db');const a=new Database(file),b=new Database(file);
 try{a.run('PRAGMA journal_mode=WAL');migrate(a,old);seed(a,'pending','x',1);seed(a,'pending','x',2);const before=rows(a);
 a.run('BEGIN IMMEDIATE');expect(()=>migrate(b,migrations)).toThrow(/locked/);expect(rows(a)).toEqual(before);a.run('COMMIT');
 migrate(b,migrations);expect(migrate(a,migrations)).toEqual([]);checks(a);checks(b);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('registry explicitly orders 088, preparation and 089; missing partner fails before normalization',()=>{
 const at=migrations.findIndex(m=>m.id==='088_employee_hiring_proposals');
 expect(migrations.slice(at).map(m=>m.id)).toEqual(['088_employee_hiring_proposals',prep,'089_hiring_proposal_dedup']);
 const db=new Database(':memory:');try{migrate(db,old);seed(db,'pending','x',1);seed(db,'pending','x',2);const before=rows(db);
 expect(()=>migrate(db,migrations.filter(m=>m.id!=='089_hiring_proposal_dedup'))).toThrow(/partner/);expect(rows(db)).toEqual(before);
 }finally{db.close();}
});
test('ambiguous unsafe integer state fails closed without rounding history',()=>{
 const db=new Database(':memory:');try{migrate(db,old);const id=seed(db,'pending','x',1);seed(db,'pending','x',2);
 db.run("UPDATE hiring_proposals SET created_at=9223372036854775807 WHERE id=?",[id]);
 const raw=db.query('SELECT CAST(created_at AS TEXT) AS value FROM hiring_proposals WHERE id=?').get(id);
 expect(()=>migrate(db,migrations)).toThrow(/Owner-reviewed/);
 expect(db.query('SELECT CAST(created_at AS TEXT) AS value FROM hiring_proposals WHERE id=?').get(id)).toEqual(raw);
 expect(db.query("SELECT id FROM _migrations WHERE id IN (?, '089_hiring_proposal_dedup')").all(prep)).toEqual([]);
 db.run('UPDATE hiring_proposals SET created_at=1, revision=9007199254740991');
 const before=rows(db);expect(()=>migrate(db,migrations)).toThrow(/Owner-reviewed/);expect(rows(db)).toEqual(before);
 }finally{db.close();}
});
test('same-timestamp canonical selection uses binary UUID order',()=>{
 const db=new Database(':memory:');try{migrate(db,old);const a=seed(db,'pending','x',1),b=seed(db,'pending','x',1);
 migrate(db,migrations);expect(rows(db).find(r=>r.status==='pending')!.id).toBe([a,b].sort()[0]);checks(db);
 }finally{db.close();}
});

test('abrupt process exit during grouped migration recovers original WAL data on reopen',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'mig089-crash-'));const file=path.join(dir,'db');let db=new Database(file);
 try{db.run('PRAGMA journal_mode=WAL');migrate(db,old);seed(db,'pending','same',1);seed(db,'pending','same',2);const before=rows(db);db.close();
 const script=`import {Database} from 'bun:sqlite';
 import {migrate} from ${JSON.stringify(path.resolve(import.meta.dir,'../migrate.ts'))};
 import {migrations} from ${JSON.stringify(path.resolve(import.meta.dir,'../migrations/index.ts'))};
 const db=new Database(${JSON.stringify(file)});
 migrate(db,migrations.map(m=>m.id===${JSON.stringify(prep)}?{...m,apply(db){m.apply(db);process.exit(73)}}:m));`;
 const child=Bun.spawn([process.execPath,'-e',script],{env:{HOME:dir,PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
 expect(await child.exited).toBe(73);expect(await new Response(child.stderr).text()).toBe('');
 db=new Database(file);expect(rows(db)).toEqual(before);expect(db.query("SELECT name FROM sqlite_master WHERE name='hiring_legacy_provenance'").all()).toEqual([]);
 migrate(db,migrations);checks(db);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('normalized pending proposals retain Owner approval CAS and employee identity',()=>{
 const db=new Database(':memory:');try{migrate(db,old);db.run("INSERT INTO projects(path,name,added_at) VALUES('/work/project','Legacy',1)");
 const first=seed(db,'pending','one',1),second=seed(db,'pending','two',2);migrate(db,migrations);
 // Keep the historical 088→089 proof above, then upgrade before exercising the current approval core.
 const normalized=rows(db);
 expect(migrate(db,registry)).toEqual(['090_professional_runtime','091_professional_execution_turns','092_company_activity_journal','093_task_dependency_tombstones','094_task_plan_queues','095_task_queue_progression']);
 expect(rows(db)).toEqual(normalized);
 const core=new HiringProposalCore(db);
 expect(()=>core.approve(second,{expectedRevision:1})).toThrow();expect(()=>core.approve(first,{expectedRevision:2})).toThrow();
 const approved=core.approve(first,{expectedRevision:1});expect(core.approve(first,{expectedRevision:1}).employee.id).toBe(approved.employee.id);
 expect(db.query("SELECT event_type,actor_type,target_id FROM activity_events").all()).toEqual([{event_type:'employee.hired',actor_type:'owner',target_id:approved.employee.id}]);
 expect(new EmployeeProfileCore(db).getProfile(approved.employee.id)!.activePrompt.promptMarkdown).toBe('Unique prompt 1 Ж');checks(db);
 }finally{db.close();}
});
test('PM replay still returns the original proposal at pending capacity',()=>{
 const db=new Database(':memory:');try{migrate(db,migrations);db.run("INSERT INTO projects(path,name,added_at) VALUES('/work/project','Capacity',1)");
 const core=new HiringProposalCore(db);const first=seed(db,'pending','same',1);
 const {pendingPerProject}=HIRING_PROPOSAL_LIMITS;
 const roles=catalog.listRoles().filter(r=>r.slug!==role).slice(0,pendingPerProject-1);
 for(const r of roles) core.create('/work/project',{roleSlug:r.slug,justification:'Capacity test'});
 expect(core.createFromManager('/work/project',[{roleSlug:role,justification:'Replay'}],{messageId:'same'}).created.map(r=>r.id)).toEqual([first]);checks(db);
 }finally{db.close();}
});
