import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import stringWidth from 'string-width';
import {
  Box,
  Text,
  measureElement,
  useApp,
  useCursor,
  useInput,
  usePaste,
  useWindowSize,
  type DOMElement,
  type Key
} from 'ink';
import type { InteractionController, PendingInteraction } from '../interaction/controller.js';
import {
  activityElapsedMs,
  type TranscriptAnchor,
  type TurnActivityState
} from '../interaction/conversation.js';
import type { SuggestionItem } from '../terminal-input.js';
import type { ToolApprovalChoice, UserInputAnswers } from '../types.js';
import { localizeTuiActivity, localizeTuiPanelText } from '../ui-language.js';
import {
  ComposerBuffer,
  createComposerViewport,
  splitAtGraphemeCursor
} from './composer-buffer.js';
import { TerminalInputDecoder, type MouseInputEvent } from './input-decoder.js';
import {
  anchorAt,
  anchorAtFraction,
  selectedTranscriptText,
  scrollAnchor,
  transcriptViewport,
  TranscriptView,
  useTranscriptLayout,
  type TranscriptSelection,
  type TranscriptSelectionPoint
} from './transcript-view.js';
import type { TerminalKeyboardPresentation } from './terminal-keyboard.js';
import type { TerminalCapabilityProfile } from './terminal-profile.js';

export { normalizeTerminalInput, parseMouseInput } from './input-decoder.js';
export type { MouseInputEvent, NormalizedTerminalInput } from './input-decoder.js';

const MAX_SUGGESTIONS = 8;
const HEADER_HEIGHT = 1;
const ACTIVITY_HEIGHT = 1;
const FOOTER_HEIGHT = 1;

export const ENABLE_MOUSE_TRACKING = '\u001B[?1002h\u001B[?1006h';
export const DISABLE_MOUSE_TRACKING = '\u001B[?1006l\u001B[?1002l';

type NewlineKey = Pick<Key, 'ctrl' | 'meta' | 'return' | 'shift'>;

export function isExplicitNewlineInput(input: string, key: NewlineKey): boolean {
  return (
    (key.return && (key.shift || key.meta)) ||
    (key.ctrl && input.toLowerCase() === 'j') ||
    input === '\n' ||
    input === '\u001B[13;2u' ||
    input === '[13;2u' ||
    input === '\u001B[27;2;13~' ||
    input === '[27;2;13~'
  );
}

interface TuiAppProps {
  controller: InteractionController;
  copyToClipboard?: (text: string) => void;
  keyboard?: TerminalKeyboardPresentation;
  profile?: TerminalCapabilityProfile;
}

function toneColor(tone?: string): string | undefined {
  if (process.env.NO_COLOR) {
    return undefined;
  }
  switch (tone) {
    case 'success':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'error':
      return 'red';
    case 'muted':
      return 'gray';
    default:
      return 'cyan';
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const scaled = tokens / 1000;
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/u, '')}K`;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}K`;
  }
  return formatTokenCount(tokens);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function ActivityBar({
  activity,
  viewingHistory,
  newOutput,
  language
}: {
  activity?: TurnActivityState | string;
  viewingHistory: boolean;
  newOutput: boolean;
  language: 'zh-CN' | 'en';
}) {
  const [frame, setFrame] = useState(0);
  const animations = !process.env.CI && process.env.INK_SCREEN_READER !== 'true';
  useEffect(() => {
    if (!activity || typeof activity === 'string' || activity.waitingForInput || !animations)
      return;
    const timer = setInterval(() => setFrame((value) => value + 1), 80);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [activity, animations]);
  if (typeof activity === 'string') {
    return <Text color={toneColor('muted')}>{localizeTuiActivity(activity, language)}</Text>;
  }
  if (activity) {
    const spinner = animations
      ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame % 10]
      : '·';
    const label = activity.waitingForInput
      ? language === 'zh-CN'
        ? '等待输入'
        : 'Waiting for input'
      : localizeTuiActivity(activity.detail ?? activity.phase, language);
    return (
      <Text color={toneColor(activity.waitingForInput ? 'warning' : 'muted')} wrap="truncate-end">
        {spinner} {label} ({formatElapsed(activityElapsedMs(activity))})
        {newOutput ? (language === 'zh-CN' ? ' · 下方有新输出' : ' · new output below') : ''}
      </Text>
    );
  }
  return (
    <Text color={toneColor('muted')} wrap="truncate-end">
      {viewingHistory
        ? `${language === 'zh-CN' ? '正在查看历史' : 'Viewing history'}${newOutput ? (language === 'zh-CN' ? ' · 下方有新输出' : ' · new output below') : ''}`
        : ' '}
    </Text>
  );
}

function InteractionPanel({
  pending,
  height,
  language
}: {
  pending: PendingInteraction;
  height: number;
  language: 'zh-CN' | 'en';
}) {
  const zh = language === 'zh-CN';
  const title =
    pending.type === 'approval'
      ? `${zh ? '操作审批' : 'Approval'}: ${pending.request.toolName}`
      : pending.type === 'question'
        ? zh
          ? 'Agent 提问'
          : 'Agent questions'
        : localizeTuiPanelText(pending.request.title, language);
  return (
    <Box
      aria-label={title}
      borderStyle="single"
      borderColor={toneColor('warning')}
      flexDirection="column"
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Text bold color={toneColor('warning')}>
        {title}
      </Text>
      {pending.type === 'confirm' ? (
        <>
          <Text>{localizeTuiPanelText(pending.request.message, language)}</Text>
          {pending.request.preview ? <Text dimColor>{pending.request.preview}</Text> : null}
          <Text>
            [{pending.request.confirmToken}] {zh ? '确认' : 'confirm'} / [N]{' '}
            {zh ? '取消' : 'cancel'}
          </Text>
          <Text>
            &gt; {pending.value ?? ''}
            <Text inverse> </Text>
          </Text>
        </>
      ) : null}
      {pending.type === 'select' ? (
        <>
          {pending.request.message ? (
            <Text dimColor>{localizeTuiPanelText(pending.request.message, language)}</Text>
          ) : null}
          {pending.request.choices.slice(0, MAX_SUGGESTIONS).map((choice, index) => (
            <Text
              key={choice.value}
              wrap="truncate-end"
              bold={index === pending.selected}
              color={index === pending.selected ? toneColor('info') : undefined}
            >
              {index === pending.selected ? '> ' : '  '}
              {choice.label}
              {choice.current ? (zh ? ' [当前]' : ' [current]') : ''}
              {choice.description ? ` - ${choice.description}` : ''}
            </Text>
          ))}
        </>
      ) : null}
      {pending.type === 'text' ? (
        <>
          {pending.request.message ? (
            <Text>{localizeTuiPanelText(pending.request.message, language)}</Text>
          ) : null}
          <Text>
            &gt; {pending.request.hidden ? '*'.repeat(pending.value.length) : pending.value}
            <Text inverse> </Text>
          </Text>
        </>
      ) : null}
      {pending.type === 'approval' ? (
        <>
          <Text>{pending.request.description}</Text>
          {pending.request.preview ? (
            <Text dimColor>
              {pending.request.preview.slice(pending.scroll, pending.scroll + 6000)}
            </Text>
          ) : null}
          <Text>
            {pending.request.choices.includes('allow-edits-session')
              ? zh
                ? '[y] 本次 / [a] 本会话编辑 / [N] 拒绝 / [Esc] 取消'
                : '[y] once / [a] session edits / [N] deny / [Esc] cancel'
              : zh
                ? '[y] 允许 / [N] 拒绝 / [Esc] 取消'
                : '[y] allow / [N] deny / [Esc] cancel'}
          </Text>
          <Text>
            &gt; {pending.value ?? ''}
            <Text inverse> </Text>
          </Text>
        </>
      ) : null}
      {pending.type === 'question' ? (
        <Text>
          {zh
            ? `Agent 提出 ${pending.request.questions.length} 个问题。使用方向键、空格和 Enter；Esc 取消。`
            : `Agent asks ${pending.request.questions.length} question(s). Use arrows/space/Enter; Esc cancels.`}
        </Text>
      ) : null}
    </Box>
  );
}

function SuggestionMenu({
  items,
  selected,
  height
}: {
  items: readonly SuggestionItem[];
  selected: number;
  height: number;
}) {
  if (items.length === 0) {
    return null;
  }
  const start = Math.max(0, Math.min(selected - 3, items.length - MAX_SUGGESTIONS));
  return (
    <Box
      aria-label="Suggestions"
      borderStyle="single"
      borderColor={toneColor('muted')}
      flexDirection="column"
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      {items.slice(start, start + MAX_SUGGESTIONS).map((item, visibleIndex) => {
        const index = start + visibleIndex;
        return (
          <Text
            key={item.id}
            wrap="truncate-end"
            bold={index === selected}
            color={index === selected ? toneColor('info') : undefined}
          >
            {index === selected ? '> ' : '  '}
            {item.label}
            {item.description ? `  ${item.description}` : ''}
          </Text>
        );
      })}
    </Box>
  );
}

function QuestionInteraction({
  pending,
  controller,
  height,
  newlineShortcut
}: {
  pending: Extract<PendingInteraction, { type: 'question' }>;
  controller: InteractionController;
  height: number;
  newlineShortcut: TerminalKeyboardPresentation['newlineShortcut'];
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  const [customMode, setCustomMode] = useState(false);
  const [answers, setAnswers] = useState<UserInputAnswers>({});
  const textBuffer = useRef(new ComposerBuffer());
  const inputDecoder = useRef(new TerminalInputDecoder());
  const [, setTextRevision] = useState(0);
  const question = pending.request.questions[questionIndex];

  useEffect(() => {
    setQuestionIndex(0);
    setSelected(0);
    setCustomMode(false);
    setAnswers({});
    textBuffer.current.clear();
    setTextRevision((value) => value + 1);
  }, [pending.id]);

  const finishQuestion = (answer: string | string[]) => {
    if (!question) {
      return;
    }
    const nextAnswers = { ...answers, [question.id]: answer };
    if (questionIndex === pending.request.questions.length - 1) {
      controller.resolvePending(nextAnswers);
      return;
    }
    setAnswers(nextAnswers);
    setQuestionIndex((value) => value + 1);
    setSelected(0);
    setCustomMode(false);
    textBuffer.current.clear();
    setTextRevision((value) => value + 1);
  };

  const updateText = (operation: () => void) => {
    operation();
    setTextRevision((value) => value + 1);
  };

  usePaste((value) => {
    if (question?.kind !== 'text' && !customMode) return;
    const next =
      textBuffer.current.value.slice(0, textBuffer.current.cursor) +
      value +
      textBuffer.current.value.slice(textBuffer.current.cursor);
    if (next.length <= 4 * 1024) updateText(() => textBuffer.current.insert(value));
  });

  const options = [
    ...(question?.options ?? []),
    ...(question?.kind !== 'text'
      ? [
          {
            value: '__syzzz_custom__',
            label:
              controller.getSnapshot().language === 'zh-CN'
                ? '输入自己的想法…'
                : 'Type my own answer…',
            description:
              controller.getSnapshot().language === 'zh-CN'
                ? '不受预设选项限制'
                : 'Type a custom answer'
          }
        ]
      : [])
  ];

  useInput((rawInput, key) => {
    const { text: input } = inputDecoder.current.push(rawInput);
    if (input.length === 0 && rawInput.length > 0) {
      return;
    }
    if (!question) {
      return;
    }
    if (key.escape && customMode) {
      setCustomMode(false);
      textBuffer.current.clear();
      setTextRevision((value) => value + 1);
      return;
    }
    if (key.escape) {
      controller.rejectPending();
      return;
    }
    if (question.kind === 'text' || customMode) {
      const text = textBuffer.current.value;
      const newlineRequested = isExplicitNewlineInput(input, key);
      if (key.return && !newlineRequested && text.trim()) {
        if (question.kind === 'multi' && customMode) {
          const current = Array.isArray(answers[question.id])
            ? (answers[question.id] as string[])
            : [];
          finishQuestion([...current, text.trim()]);
        } else {
          finishQuestion(text.trim());
        }
      } else if (newlineRequested) {
        if (text.length < 4 * 1024) updateText(() => textBuffer.current.insert('\n'));
      } else if (key.backspace) updateText(() => textBuffer.current.backspace());
      else if (key.delete) updateText(() => textBuffer.current.delete());
      else if (key.leftArrow) updateText(() => textBuffer.current.moveLeft());
      else if (key.rightArrow) updateText(() => textBuffer.current.moveRight());
      else if (key.home) updateText(() => textBuffer.current.moveHome());
      else if (key.end) updateText(() => textBuffer.current.moveEnd());
      else if (input && !key.ctrl && !key.meta && text.length + input.length <= 4 * 1024) {
        updateText(() => textBuffer.current.insert(input));
      }
      return;
    }
    if (input.toLowerCase() === 'c' && !key.ctrl && !key.meta) {
      setCustomMode(true);
      textBuffer.current.clear();
      setTextRevision((revision) => revision + 1);
      return;
    }
    if (key.upArrow) {
      setSelected((value) => (value - 1 + options.length) % options.length);
    } else if (key.downArrow) {
      setSelected((value) => (value + 1) % options.length);
    } else if (question.kind === 'multi' && input === ' ') {
      const current = Array.isArray(answers[question.id]) ? (answers[question.id] as string[]) : [];
      const value = options[selected]?.value;
      if (value === '__syzzz_custom__') {
        setCustomMode(true);
        textBuffer.current.clear();
        setTextRevision((revision) => revision + 1);
        return;
      }
      if (value) {
        setAnswers({
          ...answers,
          [question.id]: current.includes(value)
            ? current.filter((candidate) => candidate !== value)
            : [...current, value]
        });
      }
    } else if (key.return) {
      const value = options[selected]?.value;
      if (value === '__syzzz_custom__') {
        setCustomMode(true);
        textBuffer.current.clear();
        setTextRevision((revision) => revision + 1);
        return;
      }
      if (question.kind === 'single' && value) {
        finishQuestion(value);
      } else {
        const selectedValues = answers[question.id];
        if (Array.isArray(selectedValues) && selectedValues.length > 0) {
          finishQuestion(selectedValues);
        }
      }
    }
  });

  if (!question) {
    return null;
  }
  const zh = controller.getSnapshot().language === 'zh-CN';
  const boundedPrompt =
    question.prompt.length > 320 ? `${question.prompt.slice(0, 319)}…` : question.prompt;
  const maximumVisibleOptions = Math.max(2, height - 7);
  const optionStart = Math.max(
    0,
    Math.min(
      selected - Math.floor(maximumVisibleOptions / 2),
      options.length - maximumVisibleOptions
    )
  );
  const visibleOptions = options
    .slice(optionStart, optionStart + maximumVisibleOptions)
    .map((option, offset) => ({ option, index: optionStart + offset }));
  const textCursor = splitAtGraphemeCursor(textBuffer.current.value, textBuffer.current.cursor);
  return (
    <Box
      aria-label="Agent questions"
      borderStyle="single"
      borderColor={toneColor('warning')}
      flexDirection="column"
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Text bold>
        {question.header} ({questionIndex + 1}/{pending.request.questions.length})
      </Text>
      <Text wrap="truncate-end">{boundedPrompt}</Text>
      {question.kind === 'text' || customMode ? (
        <Text>
          {customMode
            ? controller.getSnapshot().language === 'zh-CN'
              ? '我的想法: '
              : 'My answer: '
            : ''}
          {textCursor.before}
          <Text inverse>{textCursor.current || ' '}</Text>
          {textCursor.after}
        </Text>
      ) : (
        visibleOptions.map(({ option, index }) => {
          const checked =
            Array.isArray(answers[question.id]) && answers[question.id].includes(option.value);
          return (
            <Text
              key={option.value}
              wrap="truncate-end"
              bold={selected === index}
              color={selected === index ? toneColor('info') : undefined}
            >
              {question.kind === 'multi'
                ? `[${checked ? 'x' : ' '}] `
                : selected === index
                  ? '> '
                  : '  '}
              {option.label}
              {option.description ? ` - ${option.description}` : ''}
            </Text>
          );
        })
      )}
      <Text dimColor>
        {question.kind === 'text' || customMode
          ? zh
            ? `Enter 提交 · ${newlineShortcut} 换行 · Esc 返回`
            : `Enter submit · ${newlineShortcut} newline · Esc back`
          : zh
            ? '↑↓ 选择 · Enter 确认 · C 输入自己的想法'
            : '↑↓ select · Enter confirm · C type my own answer'}
      </Text>
    </Box>
  );
}

function useSuggestions(
  controller: InteractionController,
  value: string,
  cursor: number,
  dismissed: boolean
): readonly SuggestionItem[] {
  const [items, setItems] = useState<readonly SuggestionItem[]>([]);
  useEffect(() => {
    if (dismissed) {
      setItems([]);
      return;
    }
    const provider = controller.suggestions.find((candidate) => candidate.match(value, cursor));
    const request = provider?.match(value, cursor);
    if (!provider || !request) {
      setItems([]);
      return;
    }
    const abort = new AbortController();
    Promise.resolve(provider.suggest(request, abort.signal))
      .then((next) => {
        if (!abort.signal.aborted) {
          setItems(next);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setItems([]);
        }
      });
    return () => abort.abort();
  }, [controller, cursor, dismissed, value]);
  return items;
}

export function TuiApp({ controller, copyToClipboard, keyboard, profile }: TuiAppProps) {
  const state = useSyncExternalStore(controller.subscribe.bind(controller), controller.getSnapshot);
  const { columns = 80, rows = 24 } = useWindowSize();
  const { exit } = useApp();
  const { setCursorPosition } = useCursor();
  const composer = useRef(new ComposerBuffer());
  const inputDecoder = useRef(new TerminalInputDecoder());
  const composerContentRef = useRef<DOMElement | null>(null);
  const [composerOrigin, setComposerOrigin] = useState<{ x: number; y: number }>();
  const [composerRevision, redraw] = useState(0);
  const [suggestionSelected, setSuggestionSelected] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(controller.inputHistory.length);
  const [historyDraft, setHistoryDraft] = useState('');
  const [transcriptAnchor, setTranscriptAnchor] = useState<TranscriptAnchor>();
  const [stickyExpanded, setStickyExpanded] = useState(false);
  const [newOutput, setNewOutput] = useState(false);
  const transcriptSignature = useRef('');
  const [lastIdleInterrupt, setLastIdleInterrupt] = useState(0);
  const [transcriptSelection, setTranscriptSelection] = useState<TranscriptSelection>();
  const [copyToast, setCopyToast] = useState<string>();
  const copyToastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectionDrag = useRef<
    | {
        start: TranscriptSelectionPoint;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const scrollbarDragging = useRef<{ grabOffset: number } | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyToastTimer.current) clearTimeout(copyToastTimer.current);
    },
    []
  );
  const suggestions = useSuggestions(
    controller,
    composer.current.value,
    composer.current.cursor,
    suggestionsDismissed || state.state !== 'idle'
  );
  // Windows consoles scroll when the bottom-right cell is written. Keeping the
  // final physical row untouched lets Ink use changed-line rendering instead of
  // its Windows fullscreen clear fallback on every frame.
  const frameRows = Math.max(1, rows - 1);
  const compact = columns < 60 || rows < 18;
  const tooSmall = columns < 36 || rows < 12;
  const composerPrompt = '> ';
  const composerPromptWidth = stringWidth(composerPrompt);
  const composerViewport = useMemo(
    () =>
      createComposerViewport(
        composer.current.value,
        composer.current.cursor,
        Math.max(1, columns - 6 - composerPromptWidth),
        compact ? 2 : 5
      ),
    [columns, compact, composerPromptWidth, composerRevision]
  );
  const composerHeight = composerViewport.lines.length + 2;
  const suggestionHeight =
    suggestions.length > 0 ? Math.min(MAX_SUGGESTIONS, suggestions.length) + 2 : 0;
  const interactionHeight = state.pending
    ? Math.min(compact ? 7 : 12, Math.max(4, frameRows - 8))
    : 0;
  const availableTranscriptHeight = Math.max(
    1,
    frameRows -
      HEADER_HEIGHT -
      ACTIVITY_HEIGHT -
      FOOTER_HEIGHT -
      composerHeight -
      suggestionHeight -
      interactionHeight
  );
  const desiredTranscriptWidth = Math.max(10, columns - 3);
  const [settledTranscriptWidth, setSettledTranscriptWidth] = useState(desiredTranscriptWidth);
  useEffect(() => {
    const timer = setTimeout(
      () => setSettledTranscriptWidth(desiredTranscriptWidth),
      profile?.resizeDebounceMs ?? 75
    );
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [desiredTranscriptWidth, profile?.resizeDebounceMs]);
  // Shrink immediately to avoid overflow; debounce expansion so a resize drag
  // does not continuously re-lex and reflow the full visible transcript.
  const transcriptWidth = Math.min(desiredTranscriptWidth, settledTranscriptWidth);
  const transcriptLayout = useTranscriptLayout(state.transcript, transcriptWidth, state.language);
  const currentTranscriptViewport = useMemo(
    () =>
      transcriptViewport(
        transcriptLayout,
        transcriptWidth,
        availableTranscriptHeight,
        transcriptAnchor,
        stickyExpanded,
        state.language
      ),
    [
      availableTranscriptHeight,
      stickyExpanded,
      transcriptAnchor,
      transcriptLayout,
      transcriptWidth,
      state.language
    ]
  );
  const viewingHistory = transcriptAnchor !== undefined;
  const moveTranscript = (rowsToMove: number) => {
    setStickyExpanded(false);
    setTranscriptAnchor((current) =>
      scrollAnchor(transcriptLayout, current, availableTranscriptHeight, rowsToMove)
    );
  };

  useEffect(() => {
    const signature = state.transcript
      .map((block) =>
        block.kind === 'assistant'
          ? `${block.id}:${block.markdown.length}:${block.status}`
          : block.kind === 'tool-group'
            ? `${block.id}:${block.items.length}:${block.items.map((item) => item.status).join(',')}`
            : `${block.id}:${block.kind}`
      )
      .join('|');
    if (
      transcriptAnchor &&
      transcriptSignature.current &&
      transcriptSignature.current !== signature
    ) {
      setNewOutput(true);
    }
    transcriptSignature.current = signature;
  }, [state.transcript, transcriptAnchor]);

  useEffect(() => {
    if (!transcriptAnchor) setNewOutput(false);
  }, [transcriptAnchor]);

  useLayoutEffect(() => {
    const element = composerContentRef.current;
    if (!element || tooSmall) {
      setComposerOrigin(undefined);
      return;
    }
    const measured = measureElement(element);
    setComposerOrigin((current) =>
      current?.x === measured.x && current.y === measured.y
        ? current
        : { x: measured.x, y: measured.y }
    );
  }, [
    columns,
    composerHeight,
    composerRevision,
    interactionHeight,
    frameRows,
    suggestionHeight,
    tooSmall
  ]);

  if (tooSmall || state.pending || state.state !== 'idle' || !composerOrigin) {
    setCursorPosition(undefined);
  } else {
    setCursorPosition({
      x: composerOrigin.x + composerPromptWidth + composerViewport.cursorX,
      y: composerOrigin.y + composerViewport.cursorRow
    });
  }

  useEffect(() => {
    if (state.state === 'exiting') {
      exit();
    }
  }, [exit, state.state]);

  const mutateComposer = (operation: () => void) => {
    operation();
    setSuggestionsDismissed(false);
    setSuggestionSelected(0);
    redraw((value) => value + 1);
  };

  const acceptSuggestion = (submit: boolean): boolean => {
    const item = suggestions[suggestionSelected];
    if (!item) {
      return false;
    }
    const value = composer.current.value;
    composer.current.set(
      value.slice(0, item.replaceStart) + item.insertText + value.slice(item.replaceEnd),
      item.replaceStart + item.insertText.length
    );
    setSuggestionsDismissed(true);
    redraw((revision) => revision + 1);
    if (submit && item.submitOnAccept) {
      const submitted = composer.current.value;
      composer.current.clear();
      void controller.submit(submitted);
    }
    return true;
  };

  const handlePendingInput = (input: string, key: Key): boolean => {
    const pending = state.pending;
    if (!pending || pending.type === 'question') {
      return false;
    }
    if (key.escape) {
      controller.rejectPending();
      return true;
    }
    if (pending.type === 'confirm') {
      const value = pending.value ?? '';
      if (key.return) {
        controller.resolvePending(
          value === pending.request.confirmToken ||
            (pending.request.confirmToken === 'y' && value === 'Y')
        );
      } else if (key.backspace || key.delete) {
        controller.updatePending({ value: Array.from(value).slice(0, -1).join('') });
      } else if (input && !key.ctrl && !key.meta && value.length + input.length <= 8) {
        controller.updatePending({ value: value + input });
      }
      return true;
    }
    if (pending.type === 'approval') {
      const value = pending.value ?? '';
      if (key.pageDown || key.downArrow) {
        controller.updatePending({ scroll: pending.scroll + 500 });
      } else if (key.pageUp || key.upArrow) {
        controller.updatePending({ scroll: Math.max(0, pending.scroll - 500) });
      } else if (key.return) {
        const normalized = value.toLowerCase();
        let choice: ToolApprovalChoice = 'deny';
        if (normalized === 'y') choice = 'allow-once';
        if (normalized === 'a' && pending.request.choices.includes('allow-edits-session')) {
          choice = 'allow-edits-session';
        }
        controller.resolvePending(choice);
      } else if (key.backspace || key.delete) {
        controller.updatePending({ value: Array.from(value).slice(0, -1).join('') });
      } else if (input && !key.ctrl && !key.meta && value.length + input.length <= 8) {
        controller.updatePending({ value: value + input });
      }
      return true;
    }
    if (pending.type === 'select') {
      if (key.upArrow) {
        controller.updatePending({
          selected:
            (pending.selected - 1 + pending.request.choices.length) % pending.request.choices.length
        });
      } else if (key.downArrow) {
        controller.updatePending({
          selected: (pending.selected + 1) % pending.request.choices.length
        });
      } else if (key.return) {
        controller.resolvePending(pending.request.choices[pending.selected]?.value);
      }
      return true;
    }
    if (pending.type === 'text') {
      if (key.return) {
        controller.resolvePending(pending.value);
      } else if (key.backspace || key.delete) {
        controller.updatePending({ value: Array.from(pending.value).slice(0, -1).join('') });
      } else if (
        input &&
        !key.ctrl &&
        !key.meta &&
        pending.value.length + input.length <= (pending.request.maximumCharacters ?? 4 * 1024)
      ) {
        controller.updatePending({ value: pending.value + input });
      }
      return true;
    }
    return false;
  };

  const handleMouseInput = (mouseInput: MouseInputEvent): void => {
    if (mouseInput.type === 'wheel') {
      moveTranscript(mouseInput.direction * 3);
      return;
    }
    if (mouseInput.type === 'other') return;
    const transcriptTop = HEADER_HEIGHT + 1;
    const localRow = Math.max(
      0,
      Math.min(availableTranscriptHeight - 1, mouseInput.y - transcriptTop)
    );
    const insideTranscript =
      mouseInput.y >= transcriptTop && mouseInput.y < transcriptTop + availableTranscriptHeight;
    const onScrollbar = insideTranscript && mouseInput.x >= columns - 1;
    const updateScrollbar = () => {
      const trackRange = Math.max(
        1,
        availableTranscriptHeight - currentTranscriptViewport.thumbSize
      );
      const grabOffset = scrollbarDragging.current?.grabOffset ?? 0;
      const fraction = Math.max(0, Math.min(1, (localRow - grabOffset) / trackRange));
      setStickyExpanded(false);
      setTranscriptSelection(undefined);
      setTranscriptAnchor(anchorAtFraction(transcriptLayout, availableTranscriptHeight, fraction));
    };
    if (mouseInput.type === 'press' && onScrollbar) {
      const thumbEnd = currentTranscriptViewport.thumbStart + currentTranscriptViewport.thumbSize;
      scrollbarDragging.current = {
        grabOffset:
          localRow >= currentTranscriptViewport.thumbStart && localRow < thumbEnd
            ? localRow - currentTranscriptViewport.thumbStart
            : Math.floor(currentTranscriptViewport.thumbSize / 2)
      };
      selectionDrag.current = undefined;
      updateScrollbar();
      return;
    }
    if (mouseInput.type === 'move' && scrollbarDragging.current) {
      updateScrollbar();
      return;
    }
    if (mouseInput.type === 'release' && scrollbarDragging.current) {
      updateScrollbar();
      scrollbarDragging.current = undefined;
      return;
    }
    if (!insideTranscript || mouseInput.x < 2 || mouseInput.x >= columns - 1) {
      if (mouseInput.type === 'release') selectionDrag.current = undefined;
      return;
    }
    const point: TranscriptSelectionPoint = {
      row: localRow,
      column: Math.max(0, Math.min(transcriptWidth, mouseInput.x - 2))
    };
    if (mouseInput.type === 'press') {
      selectionDrag.current = { start: point, moved: false };
      setTranscriptSelection({ start: point, end: point });
      return;
    }
    const drag = selectionDrag.current;
    if (mouseInput.type === 'move' && drag) {
      if (point.row !== drag.start.row || point.column !== drag.start.column) drag.moved = true;
      setTranscriptSelection({ start: drag.start, end: point });
      return;
    }
    if (mouseInput.type === 'release' && drag) {
      selectionDrag.current = undefined;
      const selection = { start: drag.start, end: point };
      if (!drag.moved && point.row === drag.start.row && point.column === drag.start.column) {
        setTranscriptSelection(undefined);
        if (viewingHistory && localRow < currentTranscriptViewport.stickyRows) {
          setStickyExpanded((value) => !value);
        }
        return;
      }
      setTranscriptSelection(selection);
      const selected = selectedTranscriptText(currentTranscriptViewport, selection);
      if (selected) {
        try {
          if (copyToClipboard) {
            copyToClipboard(selected);
            if (copyToastTimer.current) clearTimeout(copyToastTimer.current);
            setCopyToast(state.language === 'zh-CN' ? '已复制！' : 'Copied!');
            copyToastTimer.current = setTimeout(() => setCopyToast(undefined), 1_200);
            copyToastTimer.current.unref?.();
          }
        } catch (error) {
          controller.notice({
            tone: 'warning',
            text:
              state.language === 'zh-CN'
                ? `复制失败：${error instanceof Error ? error.message : String(error)}`
                : `Copy failed: ${error instanceof Error ? error.message : String(error)}`
          });
        }
      }
    }
  };

  usePaste((text) => {
    if (state.state !== 'idle') return;
    if (!composer.current.insert(text)) {
      controller.notice({
        tone: 'warning',
        text:
          state.language === 'zh-CN'
            ? '输入内容已达到上限（256 KiB）。'
            : 'Composer limit reached (256 KiB).'
      });
    }
    redraw((value) => value + 1);
  });

  useInput((rawInput, key) => {
    const normalized = inputDecoder.current.push(rawInput);
    for (const mouseInput of normalized.mouseEvents) {
      handleMouseInput(mouseInput);
    }
    const input = normalized.text;
    if (input.length === 0 && normalized.mouseEvents.length > 0) {
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'c') {
      if (suggestions.length > 0) {
        setSuggestionsDismissed(true);
      } else if (!composer.current.empty) {
        mutateComposer(() => composer.current.clear());
      } else if (controller.abortCurrent()) {
        return;
      } else {
        const now = Date.now();
        if (now - lastIdleInterrupt <= 2_000) {
          controller.requestExit('interrupt');
        } else {
          setLastIdleInterrupt(now);
          controller.notice({
            tone: 'warning',
            text:
              state.language === 'zh-CN'
                ? '请在两秒内再次按 Ctrl+C 退出。'
                : 'Press Ctrl+C again within two seconds to exit.'
          });
        }
      }
      return;
    }
    if (key.escape && transcriptSelection) {
      setTranscriptSelection(undefined);
      return;
    }
    if (handlePendingInput(input, key) || state.pending?.type === 'question') {
      return;
    }
    if (state.state !== 'idle' || tooSmall) return;
    if (key.ctrl && input.toLowerCase() === 'o') {
      controller.toggleLatestToolDetail();
      return;
    }
    if (key.pageUp) {
      moveTranscript(-Math.max(3, availableTranscriptHeight - 1));
      return;
    }
    if (key.pageDown) {
      moveTranscript(Math.max(3, availableTranscriptHeight - 1));
      return;
    }
    if (key.ctrl && key.home) {
      setStickyExpanded(false);
      setTranscriptAnchor(anchorAt(transcriptLayout, 0));
      return;
    }
    if (key.ctrl && key.end) {
      setStickyExpanded(false);
      setTranscriptAnchor(undefined);
      return;
    }
    if (key.escape) {
      setSuggestionsDismissed(true);
      return;
    }
    if (suggestions.length > 0 && key.upArrow) {
      setSuggestionSelected((value) => (value - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (suggestions.length > 0 && key.downArrow) {
      setSuggestionSelected((value) => (value + 1) % suggestions.length);
      return;
    }
    if (suggestions.length > 0 && key.tab) {
      acceptSuggestion(false);
      return;
    }
    const newlineRequested = isExplicitNewlineInput(input, key);
    if (key.return || newlineRequested) {
      if (newlineRequested) {
        mutateComposer(() => {
          composer.current.insert('\n');
        });
      } else if (!acceptSuggestion(true) && !composer.current.empty) {
        const value = composer.current.value;
        composer.current.clear();
        setHistoryIndex(controller.inputHistory.length + 1);
        setStickyExpanded(false);
        setTranscriptAnchor(undefined);
        redraw((revision) => revision + 1);
        void controller.submit(value);
      }
      return;
    }
    if (key.leftArrow) mutateComposer(() => composer.current.moveLeft());
    else if (key.rightArrow) mutateComposer(() => composer.current.moveRight());
    else if (key.home) mutateComposer(() => composer.current.moveHome());
    else if (key.end) mutateComposer(() => composer.current.moveEnd());
    else if (key.backspace)
      mutateComposer(() => {
        composer.current.backspace();
      });
    else if (key.delete)
      mutateComposer(() => {
        composer.current.delete();
      });
    else if (key.upArrow) {
      if (composer.current.value.includes('\n')) {
        mutateComposer(() => composer.current.moveVertical(-1));
      } else if (controller.inputHistory.length > 0) {
        if (historyIndex >= controller.inputHistory.length) setHistoryDraft(composer.current.value);
        const next = Math.max(0, Math.min(historyIndex - 1, controller.inputHistory.length - 1));
        setHistoryIndex(next);
        mutateComposer(() => composer.current.set(controller.inputHistory[next] ?? ''));
      }
    } else if (key.downArrow) {
      if (composer.current.value.includes('\n')) {
        mutateComposer(() => composer.current.moveVertical(1));
      } else if (historyIndex < controller.inputHistory.length) {
        const next = historyIndex + 1;
        setHistoryIndex(next);
        mutateComposer(() =>
          composer.current.set(
            next === controller.inputHistory.length
              ? historyDraft
              : (controller.inputHistory[next] ?? '')
          )
        );
      }
    } else if (input && !key.ctrl && !key.meta) {
      mutateComposer(() => {
        if (!composer.current.insert(input)) {
          controller.notice({
            tone: 'warning',
            text:
              state.language === 'zh-CN'
                ? '输入内容已达到上限（256 KiB）。'
                : 'Composer limit reached (256 KiB).'
          });
        }
      });
    }
  });

  if (tooSmall) {
    return (
      <Box
        width={columns}
        height={frameRows}
        alignItems="center"
        justifyContent="center"
        flexDirection="column"
      >
        <Text bold>{state.language === 'zh-CN' ? '终端窗口过小' : 'Terminal too small'}</Text>
        <Text>
          {state.language === 'zh-CN'
            ? '请调整到至少 36 x 12；Ctrl+C 仍可取消或退出。'
            : 'Resize to at least 36 x 12. Ctrl+C still cancels or exits.'}
        </Text>
      </Box>
    );
  }

  const status = state.status;
  const permissionScope = state.session?.permissionScope;
  const permissionLabel =
    status.permissionMode === 'acceptEdits' && permissionScope && permissionScope !== 'none'
      ? `acceptEdits:${permissionScope === 'workspace' ? 'workspace' : 'conversation'}`
      : status.permissionMode;
  const sessionLabel = status.sessionId.slice(0, 8);
  const keyboardPresentation = keyboard ?? {
    shiftEnterAvailable: false,
    newlineShortcut: 'Ctrl+J' as const
  };
  return (
    <Box
      aria-label="Syzzz Code fullscreen terminal interface"
      width={columns}
      height={frameRows}
      flexDirection="column"
      paddingX={1}
    >
      <Box height={HEADER_HEIGHT} justifyContent="space-between" overflow="hidden">
        <Text bold color={toneColor('info')} wrap="truncate-end">
          Syzzz Code
        </Text>
        <Text dimColor wrap="truncate-start">
          {compact
            ? `${status.workspaceRoot} | #${sessionLabel}`
            : `${status.workspaceRoot} | ${status.sessionId}`}
        </Text>
      </Box>
      <TranscriptView
        layout={transcriptLayout}
        width={transcriptWidth}
        height={availableTranscriptHeight}
        anchor={transcriptAnchor}
        stickyExpanded={stickyExpanded}
        selection={transcriptSelection}
        language={state.language}
      />
      <Box height={ACTIVITY_HEIGHT} overflow="hidden">
        <ActivityBar
          activity={
            state.activity ??
            (transcriptLayout.pendingPresentationRows > 0
              ? state.language === 'zh-CN'
                ? '正在呈现回答...'
                : 'Rendering response...'
              : undefined)
          }
          viewingHistory={viewingHistory}
          newOutput={newOutput}
          language={state.language}
        />
      </Box>
      {state.pending?.type === 'question' ? (
        <QuestionInteraction
          pending={state.pending}
          controller={controller}
          height={interactionHeight}
          newlineShortcut={keyboardPresentation.newlineShortcut}
        />
      ) : state.pending ? (
        <InteractionPanel
          pending={state.pending}
          height={interactionHeight}
          language={state.language}
        />
      ) : null}
      {!state.pending && suggestions.length > 0 ? (
        <SuggestionMenu
          items={suggestions}
          selected={suggestionSelected}
          height={suggestionHeight}
        />
      ) : null}
      <Box
        aria-label="Message composer"
        borderStyle="single"
        borderColor={toneColor('info')}
        paddingX={1}
        flexDirection="column"
        height={composerHeight}
        overflow="hidden"
      >
        <Box ref={composerContentRef} flexDirection="column">
          {composerViewport.lines.map((line, index) => (
            <Text key={`${composerViewport.firstLogicalLine + index}:${line}`} wrap="truncate-end">
              <Text color={toneColor('info')}>
                {index === 0 ? composerPrompt : ' '.repeat(composerPromptWidth)}
              </Text>
              {line || ' '}
            </Text>
          ))}
        </Box>
      </Box>
      <Box height={FOOTER_HEIGHT} overflow="hidden" justifyContent="space-between">
        <Box flexGrow={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {viewingHistory
              ? `${state.language === 'zh-CN' ? '历史' : 'History'} | ${status.provider.name} / ${status.provider.model} | ${status.mode}|${permissionLabel} | ${formatTokenCount(status.context.estimatedInputTokens)}/${formatContextWindow(status.context.contextWindowTokens)} ctx`
              : `${status.provider.name} / ${status.provider.model} | ${status.mode}|${permissionLabel} | ${formatTokenCount(status.context.estimatedInputTokens)}/${formatContextWindow(status.context.contextWindowTokens)} ctx | ${state.stats.tools} ${state.language === 'zh-CN' ? '次工具' : 'tools'}`}
          </Text>
        </Box>
        {copyToast ? <Text color={toneColor('success')}> {copyToast}</Text> : null}
      </Box>
    </Box>
  );
}
