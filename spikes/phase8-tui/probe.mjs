import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { Phase8SpikeView } from './app.mjs';

const h = React.createElement;

function ttyOutput(columns = 100, rows = 30) {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  stream.getColorDepth = () => 8;
  stream.hasColors = () => true;
  return stream;
}

const stdout = ttyOutput();
const stderr = ttyOutput();
let outputBytes = 0;
stdout.on('data', (chunk) => {
  outputBytes += chunk.length;
});
const baseTranscript = [
  { role: 'user', text: 'Probe streaming renderer throughput.' },
  { role: 'assistant', text: '' }
];
const instance = render(h(Phase8SpikeView, { transcript: baseTranscript }), {
  concurrent: true,
  incrementalRendering: true,
  interactive: true,
  maxFps: 30,
  patchConsole: false,
  stderr,
  stdout
});
await instance.waitUntilRenderFlush();

const startedAt = performance.now();
let streamed = '';
for (let index = 0; index < 1000; index += 1) {
  streamed += index % 10;
  instance.rerender(
    h(Phase8SpikeView, {
      transcript: [baseTranscript[0], { role: 'assistant', text: streamed }]
    })
  );
}
const dispatchDurationMs = performance.now() - startedAt;
await instance.waitUntilRenderFlush();
const flushDurationMs = performance.now() - startedAt;
instance.unmount();
await instance.waitUntilExit();

console.log(
  JSON.stringify({
    schemaVersion: 1,
    updates: 1000,
    dispatchDurationMs: Math.round(dispatchDurationMs * 10) / 10,
    flushDurationMs: Math.round(flushDurationMs * 10) / 10,
    outputBytes
  })
);
