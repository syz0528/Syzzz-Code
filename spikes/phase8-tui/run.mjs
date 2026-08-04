import React, { useEffect, useState } from 'react';
import { render, useApp } from 'ink';
import { InteractivePhase8Spike } from './app.mjs';

const h = React.createElement;
const STREAM_TEXT =
  '这是一个独立 alternate-screen TUI 验证。输入 /、@ 或 $ 查看候选；输入 /approve-demo 打开审批演示。';

function Demo() {
  const { exit } = useApp();
  const [interaction, setInteraction] = useState();
  const [transcript, setTranscript] = useState([
    { role: 'user', text: '请验证 Phase 8 的终端交互方向。' },
    { role: 'assistant', text: '' }
  ]);

  useEffect(() => {
    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      setTranscript((current) => [
        current[0],
        { role: 'assistant', text: STREAM_TEXT.slice(0, index) }
      ]);
      if (index >= STREAM_TEXT.length) {
        clearInterval(timer);
      }
    }, 20);
    return () => clearInterval(timer);
  }, []);

  return h(InteractivePhase8Spike, {
    interaction,
    transcript,
    onAction(action) {
      if (action.type === 'cancel') {
        exit();
        return;
      }
      if (action.type === 'approval') {
        setInteraction(undefined);
        setTranscript((current) => [
          ...current,
          { role: 'assistant', text: `Approval resolved: ${action.choice}` }
        ]);
        return;
      }
      if (action.value === '/approve-demo') {
        setInteraction({
          tool: 'Shell',
          description: 'Execute a bounded command in the workspace',
          preview: 'npm test'
        });
        return;
      }
      setTranscript((current) => [
        ...current,
        { role: 'user', text: action.value },
        { role: 'assistant', text: 'Spike received the structured submit action.' }
      ]);
    }
  });
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Phase 8 TUI Spike requires an interactive TTY.');
  process.exitCode = 1;
} else {
  const instance = render(h(Demo), {
    alternateScreen: true,
    concurrent: true,
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 30
  });
  await instance.waitUntilExit();
  console.log('Phase 8 TUI Spike exited cleanly.');
}
