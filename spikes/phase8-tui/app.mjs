import React, { useMemo, useState } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';

const h = React.createElement;

export const SPIKE_SUGGESTIONS = [
  {
    trigger: '/',
    label: '/model',
    replacement: '/model ',
    description: '切换当前 Provider 模型'
  },
  {
    trigger: '/',
    label: '/permissions',
    replacement: '/permissions ',
    description: '调整当前会话权限'
  },
  {
    trigger: '/',
    label: '/approve-demo',
    replacement: '/approve-demo',
    description: '打开结构化审批演示'
  },
  {
    trigger: '@',
    label: '@src/runtime-engine.ts',
    replacement: '@src/runtime-engine.ts',
    description: '工作区文件上下文'
  },
  {
    trigger: '$',
    label: '$phase71-demo',
    replacement: '$phase71-demo ',
    description: 'Phase 7.1 Skill 工作流'
  },
  {
    trigger: '$',
    label: '$review',
    replacement: '$review ',
    description: '只读代码审查工作流'
  }
];

function normalizeLines(value) {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function activeTrigger(value) {
  const token = value.split(/\s/u).at(-1) ?? '';
  return token.startsWith('/') || token.startsWith('@') || token.startsWith('$')
    ? token[0]
    : undefined;
}

function suggestionQuery(value) {
  const token = value.split(/\s/u).at(-1) ?? '';
  return token.slice(1).toLowerCase();
}

function replaceActiveToken(value, replacement) {
  const index = Math.max(value.lastIndexOf(' '), value.lastIndexOf('\n'));
  return `${value.slice(0, index + 1)}${replacement}`;
}

function visibleTranscript(transcript, rows) {
  const available = Math.max(3, rows - 13);
  return transcript.slice(-available);
}

function Header({ compact, status }) {
  if (compact) {
    return h(
      Box,
      { justifyContent: 'space-between' },
      h(Text, { bold: true, color: 'cyan' }, 'Syzzz · Phase 8'),
      h(Text, { dimColor: true }, `${status.mode}|${status.permission}`)
    );
  }
  return h(
    Box,
    { justifyContent: 'space-between' },
    h(Text, { bold: true, color: 'cyan' }, 'Syzzz Code · Phase 8 TUI Spike'),
    h(Text, { dimColor: true }, `${status.provider} · ${status.model}`)
  );
}

function Transcript({ entries, rows }) {
  const visible = visibleTranscript(entries, rows);
  return h(
    Box,
    { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
    ...visible.map((entry, index) =>
      h(
        Text,
        { key: `${entry.role}-${index}`, wrap: 'wrap' },
        h(
          Text,
          { bold: true, color: entry.role === 'assistant' ? 'green' : 'blue' },
          entry.role === 'assistant' ? 'Assistant: ' : 'You: '
        ),
        entry.text
      )
    )
  );
}

function ApprovalPanel({ request }) {
  if (!request) {
    return null;
  }
  return h(
    Box,
    { borderStyle: 'single', borderColor: 'yellow', flexDirection: 'column', paddingX: 1 },
    h(Text, { bold: true, color: 'yellow' }, `Approval · ${request.tool}`),
    h(Text, null, request.description),
    h(Text, { dimColor: true }, request.preview),
    h(Text, null, '[y] 本次允许  [a] 本会话编辑  [N] 拒绝  [Esc] 取消')
  );
}

function SuggestionMenu({ compact, suggestions, selected }) {
  if (suggestions.length === 0) {
    return null;
  }
  return h(
    Box,
    { borderStyle: 'single', borderColor: 'gray', flexDirection: 'column', paddingX: 1 },
    ...suggestions
      .slice(0, 5)
      .map((item, index) =>
        h(
          Text,
          { key: item.label, inverse: index === selected },
          `${index === selected ? '›' : ' '} ${item.label}${compact ? '' : `  ${item.description}`}`
        )
      )
  );
}

function Composer({ value, status }) {
  return h(
    Box,
    {
      borderStyle: 'single',
      borderColor: 'cyan',
      flexDirection: 'column',
      paddingX: 1,
      minHeight: 4
    },
    h(Text, { color: 'cyan' }, `You [${status.mode}|${status.permission}]`),
    h(Text, null, value, h(Text, { inverse: true }, ' '))
  );
}

function Footer({ compact, status }) {
  if (compact) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { dimColor: true }, 'Enter submit · Esc dismiss · Ctrl+C cancel'),
      h(Text, { dimColor: true }, `${status.contextPercent}% ctx · ${status.session}`)
    );
  }
  return h(
    Box,
    { justifyContent: 'space-between' },
    h(Text, { dimColor: true }, 'Enter submit · Shift+Enter newline · Esc dismiss · Ctrl+C cancel'),
    h(
      Text,
      { dimColor: true },
      `${status.contextPercent}% ctx · ${status.tools} tools · ${status.session}`
    )
  );
}

export function Phase8SpikeView({
  composer = '',
  interaction,
  selected = 0,
  status = {
    provider: 'OpenCode',
    model: 'gpt-5.6-luna',
    mode: 'code',
    permission: 'safe',
    contextPercent: 18,
    tools: 2,
    session: 'spike'
  },
  suggestions = [],
  transcript = [],
  viewport
}) {
  const windowSize = useWindowSize();
  const columns = Math.max(36, viewport?.columns ?? windowSize.columns ?? 80);
  const rows = Math.max(16, viewport?.rows ?? windowSize.rows ?? 24);
  const compact = columns < 60;

  return h(
    Box,
    { flexDirection: 'column', width: columns, height: rows, paddingX: 1 },
    h(Header, { compact, status }),
    h(Box, { height: 1 }, h(Text, { dimColor: true }, '─'.repeat(Math.max(1, columns - 2)))),
    h(Transcript, { entries: transcript, rows }),
    h(ApprovalPanel, { request: interaction }),
    h(SuggestionMenu, { compact, suggestions, selected }),
    h(Composer, { value: composer, status }),
    h(Footer, { compact, status })
  );
}

export function InteractivePhase8Spike({
  initialComposer = '',
  interaction,
  onAction = () => {},
  status,
  suggestionCatalog = SPIKE_SUGGESTIONS,
  transcript,
  viewport
}) {
  const [composer, setComposer] = useState(initialComposer);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const trigger = activeTrigger(composer);
  const query = suggestionQuery(composer);
  const suggestions = useMemo(
    () =>
      dismissed || !trigger
        ? []
        : suggestionCatalog.filter(
            (item) => item.trigger === trigger && item.label.slice(1).toLowerCase().includes(query)
          ),
    [dismissed, query, suggestionCatalog, trigger]
  );

  usePaste((text) => {
    setComposer((current) => `${current}${normalizeLines(text)}`);
    setDismissed(false);
  });

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      onAction({ type: 'cancel' });
      return;
    }

    if (interaction) {
      if (key.escape) {
        onAction({ type: 'approval', choice: 'cancel' });
      } else if (input === 'y' || input === 'Y') {
        onAction({ type: 'approval', choice: 'allow-once' });
      } else if (input === 'a' || input === 'A') {
        onAction({ type: 'approval', choice: 'allow-edits-session' });
      } else if (input === 'n' || input === 'N' || key.return) {
        onAction({ type: 'approval', choice: 'deny' });
      }
      return;
    }

    if (key.escape) {
      setDismissed(true);
      return;
    }
    if (suggestions.length > 0 && key.upArrow) {
      setSelected((current) => (current - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (suggestions.length > 0 && key.downArrow) {
      setSelected((current) => (current + 1) % suggestions.length);
      return;
    }
    if (suggestions.length > 0 && (key.tab || key.return)) {
      setComposer((current) => replaceActiveToken(current, suggestions[selected].replacement));
      setSelected(0);
      setDismissed(true);
      return;
    }
    if (key.return) {
      if (key.shift) {
        setComposer((current) => `${current}\n`);
      } else if (composer.trim()) {
        onAction({ type: 'submit', value: composer });
        setComposer('');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setComposer((current) => Array.from(current).slice(0, -1).join(''));
      setDismissed(false);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setComposer((current) => `${current}${input}`);
      setSelected(0);
      setDismissed(false);
    }
  });

  return h(Phase8SpikeView, {
    composer,
    interaction,
    selected,
    status,
    suggestions,
    transcript,
    viewport
  });
}
