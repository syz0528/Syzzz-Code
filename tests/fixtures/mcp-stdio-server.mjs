import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const descendantReady = process.env.MCP_DESCENDANT_READY;
const descendantSurvived = process.env.MCP_DESCENDANT_SURVIVED;
if (descendantReady && descendantSurvived) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const fs=require('node:fs');" +
      "fs.writeFileSync(process.argv[1],String(process.pid));" +
      "setTimeout(()=>fs.writeFileSync(process.argv[2],'survived'),1500);" +
      'setTimeout(()=>{},10000)',
      descendantReady,
      descendantSurvived
    ],
    {
      stdio: 'ignore',
      windowsHide: true
    }
  );
  child.unref();
}

function createFixtureServer() {
  const server = new McpServer({
    name: 'syzzz-test-server',
    version: '1.0.0'
  });

  server.registerTool(
    'echo',
    {
      description: 'Return a UTF-8 text value',
      inputSchema: z.object({ value: z.string() }),
      annotations: { readOnlyHint: true }
    },
    async ({ value }) => ({
      content: [{ type: 'text', text: `echo:${value}` }],
      structuredContent: { value }
    })
  );

  server.registerTool(
    'environment',
    {
      description: 'Report only whether test environment values are present',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          leakedProviderKey: process.env.TEST_PROVIDER_API_KEY !== undefined,
          configuredValue: process.env.MCP_SAFE_VALUE ?? null
        })
      }]
    })
  );

  server.registerTool(
    'mutate',
    {
      description: 'A fixture side-effect tool',
      inputSchema: z.object({ value: z.string() })
    },
    async ({ value }) => ({
      content: [{ type: 'text', text: `mutated:${value}` }]
    })
  );
  return server;
}

if (process.env.MCP_SERVER_READY_FILE) {
  writeFileSync(process.env.MCP_SERVER_READY_FILE, String(process.pid));
}

serveStdio(() => createFixtureServer());
