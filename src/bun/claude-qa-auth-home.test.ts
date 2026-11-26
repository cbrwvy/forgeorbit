import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertBoundedClaudeAuthentication, CLAUDE_QA_CONFIG_SETTING as CONFIG, CLAUDE_QA_AUTH_HOME_SETTING as AUTH_HOME, CLAUDE_QA_HOME_ACCEPTANCE_SETTING as ACCEPT } from "./claude-auth-compat.ts";
import { boundedClaudeEnvironment } from "./claude-bounded-print.ts";

const root=mkdtempSync(path.join(tmpdir(),"fo-auth-home-"));
const campaign=path.join(root,"campaign"), home=path.join(campaign,"home"), temporary=path.join(campaign,"tmp"), data=path.join(campaign,"data"), project=path.join(campaign,"project");
const loginHome=path.join(root,"synthetic-login-home"), profile=path.join(loginHome,"qa-profile");
for(const dir of [home,temporary,data,project,profile]) mkdirSync(dir,{recursive:true});
process.env.HOME=home; process.env.TMPDIR=temporary; process.env.AGETOR_DATA_DIR=data;
process.env.AGETOR_CLAUDE_DRIVER="offline-executable-fixture";
for(const key of [CONFIG,AUTH_HOME,ACCEPT,"AGETOR_CLAUDE_ARGS"]) delete process.env[key];
const base={HOME:home,TMPDIR:temporary,AGETOR_DATA_DIR:data,PATH:"/usr/bin:/bin"};
const selection={[CONFIG]:profile,[AUTH_HOME]:loginHome};
const accepted={...selection,[ACCEPT]:"allow-home-access"};
const calls=path.join(project,"calls.jsonl"), bin=path.join(root,"fixture");
writeFileSync(bin,`#!${process.execPath}
import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(calls)},JSON.stringify({argv:process.argv.slice(2),home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR,tmp:process.env.TMPDIR,cwd:process.cwd(),keys:Object.keys(process.env)})+"\\n");
await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir,"claude-bounded-print.fixture.ts")).href)});
`,{mode:0o700});
const {buildCommand,spawnAgent,harnessEnv}=await import("./agents.ts");
const harness={id:"auth-home-fixture",kind:"claude-code" as const,isBuiltin:false,label:"Offline fixture",home:null,bin,enabled:true,env:accepted};
const records=()=>existsSync(calls)?readFileSync(calls,"utf8").trim().split("\n").map(s=>JSON.parse(s)):[];
const launch=(env:Record<string,string>, readOnly=false, authorize?:()=>boolean)=>spawnAgent({taskId:"offline-home-task",runId:crypto.randomUUID(),harness:{...harness,env},cwd:project,prompt:"fixture-case:success",opts:{model:"haiku-5.5",mode:"bounded-print",claudeBoundedReadOnly:readOnly},authorize,onChunk:()=>{}});
afterAll(()=>rmSync(root,{recursive:true,force:true}));

test("explicit child HOME permits its nested persistent QA config while backend paths stay isolated",async()=>{
  const env=boundedClaudeEnvironment({...base,...selection,ANTHROPIC_API_KEY:"PRIVATE",CLAUDE_CODE_OAUTH_TOKEN:"PRIVATE",AGETOR_API_TOKEN:"PRIVATE",CLAUDE_SECURESTORAGE_CONFIG_DIR:"",CLAUDE_CODE_USE_BEDROCK:"1"},{},project);
  expect(env.HOME).toBe(loginHome);expect(env.CLAUDE_CONFIG_DIR).toBe(profile);expect(env.TMPDIR).toBe(temporary);
  expect(process.env.HOME).toBe(home);expect(process.env.AGETOR_DATA_DIR).toBe(data);
  for(const key of [AUTH_HOME,ACCEPT,CONFIG,"AGETOR_API_TOKEN","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_SECURESTORAGE_CONFIG_DIR","CLAUDE_CODE_USE_BEDROCK"])expect(env[key]).toBeUndefined();
  const count=records().length;
  await assertBoundedClaudeAuthentication(bin,env,{qaConfigDirectory:profile,cwd:project});
  expect(records().slice(count)).toMatchObject([{argv:["auth","status"],home:loginHome,config:profile,tmp:temporary,cwd:project}]);
});
test("HOME policy is opt-in and requires the explicit QA config",()=>{
  expect(boundedClaudeEnvironment(base,{},project).HOME).toBe(home);
  expect(()=>boundedClaudeEnvironment({...base,[AUTH_HOME]:loginHome},{},project)).toThrow("explicitly selected");
  expect(boundedClaudeEnvironment({...base,[ACCEPT]:"allow-home-access"},{},project).HOME).toBe(home);
});
for(const [label,value] of [["empty",""],["relative","relative"],["missing",path.join(root,"missing")],["file",bin],["root","/"],["backend HOME",home],["data",data],["tmp",temporary],["project",project],["campaign",campaign],["profile",profile]]){
  test(`rejects invalid or disposable ${label} authentication HOME before a process`,async()=>{
    const count=records().length;
    await expect(launch({...accepted,[AUTH_HOME]:value!})).rejects.toThrow("persistent directories");
    expect(records()).toHaveLength(count);
  });
}
test("rejects links into cleanup data and missing isolated data/tmp/cwd",()=>{
  const link=path.join(root,"link");symlinkSync(data,link);
  expect(()=>boundedClaudeEnvironment({...base,...selection,[AUTH_HOME]:link},{},project)).toThrow();
  expect(()=>boundedClaudeEnvironment({...base,...selection,AGETOR_DATA_DIR:""},{},project)).toThrow();
  expect(()=>boundedClaudeEnvironment({...base,...selection,TMPDIR:""},{},project)).toThrow();
  expect(()=>boundedClaudeEnvironment({...base,...selection},{})).toThrow();
});
test("login HOME cannot contain backend HOME, data, project or temporary cleanup paths",()=>{
  for(const key of ["HOME","AGETOR_DATA_DIR","TMPDIR"]){
    const nested=path.join(loginHome,"disposable");mkdirSync(nested,{recursive:true});
    expect(()=>boundedClaudeEnvironment({...base,...selection,[key]:nested},{},project)).toThrow();
  }
  expect(()=>boundedClaudeEnvironment({...base,...selection},{},loginHome)).toThrow();
});
for(const acceptance of [undefined,"1","false"]){
  test(`missing/invalid HOME access acceptance (${acceptance}) prevents execution`,async()=>{
    const env:Record<string,string>={...selection};if(acceptance!==undefined)env[ACCEPT]=acceptance;
    const count=records().length;
    await expect(launch(env)).rejects.toThrow("Explicit Owner acceptance");
    expect(records()).toHaveLength(count);
  });
}
test("HOME acceptance is not an Owner execution grant",async()=>{
  const count=records().length;
  await expect(launch(accepted,false,()=>false)).rejects.toThrow("authorization changed");
  expect(records()).toHaveLength(count);
});
for(const readOnly of [false,true]){
  test(`offline ${readOnly?"Reviewer":"Developer"} uses selected HOME/config and unchanged tool policy`,async()=>{
    const count=records().length;const child=await launch(accepted,readOnly,()=>true);expect(await child.done).toBe(0);
    const actual=records().slice(count);expect(actual).toHaveLength(2);
    expect(actual[0].argv).toEqual(["auth","status"]);
    for(const record of actual){expect(record.home).toBe(loginHome);expect(record.config).toBe(profile);expect(record.tmp).toBe(temporary);expect(record.cwd).toBe(project);expect(record.keys).not.toContain(ACCEPT);}
    const argv=actual[1].argv;expect(argv[argv.indexOf("--tools")+1]).toBe(readOnly?"Read,Glob,Grep":"Read,Glob,Grep,Edit,Write");
    expect(argv[argv.indexOf("--max-turns")+1]).toBe("6");expect(argv[argv.indexOf("--max-budget-usd")+1]).toBe("0.25");
    expect(child.writeInput("no continuation")).toBe(false);
  });
}
test("environment stays frozen if ambient HOME policy changes during the auth await",async()=>{
  const keys=["HOME",AUTH_HOME,ACCEPT,"ANTHROPIC_API_KEY"];
  const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));let checks=0;const count=records().length;
  try{
    const child=await launch(accepted,false,()=>{if(++checks===2){process.env.HOME="/wrong";process.env[AUTH_HOME]="/wrong";process.env[ACCEPT]="";process.env.ANTHROPIC_API_KEY="PRIVATE";}return true;});
    expect(await child.done).toBe(0);
    for(const record of records().slice(count)){expect(record.home).toBe(loginHome);expect(record.config).toBe(profile);expect(record.keys).not.toContain("ANTHROPIC_API_KEY");}
  }finally{for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}}
});
test("authorization revoked after successful auth prevents print",async()=>{
  const count=records().length;let checks=0;
  await expect(launch(accepted,false,()=>++checks===1)).rejects.toThrow("authorization changed");
  expect(records().slice(count).map(row=>row.argv)).toEqual([["auth","status"]]);
});
test("HOME policy and acceptance changes invalidate the existing resource fingerprint",async()=>{
  const {resourceKey}=await import("./orchestrated-resources.ts");
  const noHome=resourceKey({...harness,env:{[CONFIG]:profile}});
  const unaccepted=resourceKey({...harness,env:selection});const approved=resourceKey(harness);
  expect(unaccepted).not.toBe(noHome);expect(approved).not.toBe(unaccepted);
  expect(resourceKey({...harness,env:{...accepted,[AUTH_HOME]:loginHome+"-changed"}})).not.toBe(approved);
});
test("interactive Claude and other harness HOME behavior remains unchanged",()=>{
  const command=buildCommand({...harness,home:"/ordinary/config"},"unused",{model:"haiku-5.5",effort:"low",mode:"ask"});
  expect(command.env?.CLAUDE_CONFIG_DIR).toBe("/ordinary/config");expect(command.env?.HOME).toBeUndefined();expect(command.cmd).not.toContain("--print");
  expect(harnessEnv({...harness,kind:"codex",home:home}).HOME).toBe(home);
});
test("campaign cleanup never targets either synthetic persistent directory",()=>{
  const disposable=path.join(campaign,"cleanup");mkdirSync(disposable);
  writeFileSync(path.join(loginHome,"marker"),"persistent-home");writeFileSync(path.join(profile,"marker"),"persistent-profile");
  rmSync(disposable,{recursive:true});
  expect(readFileSync(path.join(loginHome,"marker"),"utf8")).toBe("persistent-home");
  expect(readFileSync(path.join(profile,"marker"),"utf8")).toBe("persistent-profile");
});
