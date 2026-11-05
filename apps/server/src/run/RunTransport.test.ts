// @effect-diagnostics nodeBuiltinImport:off -- The protocol fixture isolates PATH changes in a child and exercises SSH exit handling through real pipes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
it.live("preserves remote failures and refuses successful transports without a valid result", () =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-transport-"));
      try {
        const fixture = NodePath.join(root, "ssh.mjs");
        await NodeFSP.writeFile(
          fixture,
          `const frame = value => process.stdout.write('\\x1eT3RUN ' + JSON.stringify(value) + '\\n');
const mode = process.env.R1_TRANSPORT_MODE;
if(mode==='transport') {process.stderr.write('route unavailable\\n');process.exitCode=255;}
else if(mode==='empty') process.exitCode=0;
else if(mode==='invalid') process.stdout.write('\\x1eT3RUN invalid\\n');
else { frame({type:'out',data:Buffer.from(process.argv.slice(2).join(' ')).toString('base64')});
if(mode==='error') frame({type:'error',message:'primary supervisor failed'});
frame({type:'done',code:mode==='remote255'?255:23,ignored:[]}); }
`,
        );
        await NodeFSP.writeFile(
          NodePath.join(root, platform === "win32" ? "ssh.cmd" : "ssh"),
          platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
            : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", `'"'"'`)}' '${fixture.replaceAll("'", `'"'"'`)}' "$@"\n`,
          { mode: 0o700 },
        );
        const transport = NodeURL.pathToFileURL(
          NodePath.resolve(import.meta.dirname, "RunTransport.ts"),
        ).href;
        const program = `import {remoteRun} from ${JSON.stringify(transport)};
const plan={kind:'remote',logicalKey:'sample',environmentId:'laptop',primaryEnvironmentId:'studio',title:'Sample',machine:'studio',host:'t3-studio',primaryRoot:'/project',replicaRoot:'/copy',cwd:'/project',platform:'posix',ignores:[]};
const results=[];
for(const mode of ['remote','remote255','transport','empty','invalid','error']) {
process.env.R1_TRANSPORT_MODE=mode;const frames=[];
try { const result=await remoteRun(plan,{action:'exec',ports:[3000,8080]},{tty:mode==='remote255',onFrame:f=>frames.push(f)});results.push({mode,result,args:frames.filter(f=>f.type==='out').map(f=>Buffer.from(f.data,'base64').toString()).join('')}); }
catch(error){results.push({mode,error:error.message});}
}
process.stdout.write(JSON.stringify(results));`;
        const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
          process.execPath,
          ["--input-type=module", "-e", program],
          { env: { ...process.env, PATH: root + NodePath.delimiter + (process.env.PATH ?? "") } },
        );
        const rows = JSON.parse(result.stdout) as ReadonlyArray<{
          mode: string;
          result?: { code: number };
          args?: string;
          error?: string;
        }>;
        expect(rows[0]?.result?.code).toBe(23);
        expect(rows[0]?.args).toContain(
          "-T -L 127.0.0.1:3000:127.0.0.1:3000 -L 127.0.0.1:8080:127.0.0.1:8080 t3-studio",
        );
        expect(rows[1]?.result?.code).toBe(255);
        expect(rows[1]?.args).toContain("-tt -L");
        expect(rows[2]?.error).toBe("Cannot run on studio: route unavailable");
        expect(rows[3]?.error).toContain("SSH closed without a command result (status 0)");
        expect(rows[4]?.error).toBe("The primary returned an invalid run frame.");
        expect(rows[5]?.error).toBe("Cannot run on studio: primary supervisor failed");
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
  ),
);
