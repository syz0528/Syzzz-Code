import type { UiFrameRate } from '../config.js';
import type { TerminalKeyboardPresentation, TerminalKeyboardStatus } from './terminal-keyboard.js';

export type TuiRendererProfile = 'standard' | 'conservative';
export type TerminalWheelInput = 'mouse-reports' | 'arrow-fallback';

export interface TerminalCapabilityProfile {
  host: TerminalKeyboardStatus['host'];
  renderer: TuiRendererProfile;
  embedded: boolean;
  kittyKeyboard: boolean;
  shiftEnter: TerminalKeyboardPresentation['newlineShortcut'];
  mouseTracking: boolean;
  wheelInput: TerminalWheelInput;
  maxFps: number;
  configuredFrameRate: UiFrameRate;
  textFrameIntervalMs: number;
  resizeDebounceMs: number;
  concurrentRendering: boolean;
  synchronizedOutput: 'ink-managed' | 'coalesced';
  override?: TuiRendererProfile;
}

export interface TuiRenderDiagnostics {
  frames: number;
  totalRenderMs: number;
  lastRenderMs: number;
  maximumRenderMs: number;
}

export function createTuiRenderDiagnostics(): TuiRenderDiagnostics {
  return { frames: 0, totalRenderMs: 0, lastRenderMs: 0, maximumRenderMs: 0 };
}

export function recordTuiRender(diagnostics: TuiRenderDiagnostics, renderTime: number): void {
  diagnostics.frames += 1;
  diagnostics.totalRenderMs += renderTime;
  diagnostics.lastRenderMs = renderTime;
  diagnostics.maximumRenderMs = Math.max(diagnostics.maximumRenderMs, renderTime);
}

function profileOverride(environment: NodeJS.ProcessEnv): TuiRendererProfile | undefined {
  const value = environment.SYZZZ_TUI_PROFILE?.trim().toLowerCase();
  return value === 'standard' || value === 'conservative' ? value : undefined;
}

export function createTerminalCapabilityProfile(options: {
  keyboardStatus: TerminalKeyboardStatus;
  keyboard: TerminalKeyboardPresentation;
  kittySupported: boolean;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  configuredFrameRate?: UiFrameRate;
}): TerminalCapabilityProfile {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const embedded = ['vscode', 'cursor', 'windsurf', 'codex'].includes(options.keyboardStatus.host);
  const override = profileOverride(environment);
  const conservativeWindowsHost =
    platform === 'win32' && (embedded || options.keyboardStatus.host === 'unknown');
  const wheelInput =
    platform === 'win32' && ['codex', 'unknown'].includes(options.keyboardStatus.host)
      ? 'arrow-fallback'
      : 'mouse-reports';
  const renderer = override ?? (conservativeWindowsHost ? 'conservative' : 'standard');
  const configuredFrameRate = options.configuredFrameRate ?? 'auto';
  const maxFps =
    configuredFrameRate === 'auto' ? (renderer === 'conservative' ? 20 : 30) : configuredFrameRate;
  return {
    host: options.keyboardStatus.host,
    renderer,
    embedded,
    kittyKeyboard: options.kittySupported,
    shiftEnter: options.keyboard.newlineShortcut,
    mouseTracking: true,
    wheelInput,
    maxFps,
    configuredFrameRate,
    textFrameIntervalMs:
      configuredFrameRate === 'auto'
        ? renderer === 'conservative'
          ? 40
          : 33
        : Math.max(16, Math.round(1000 / maxFps)),
    resizeDebounceMs: renderer === 'conservative' ? 120 : 75,
    concurrentRendering: renderer === 'standard',
    synchronizedOutput: renderer === 'conservative' ? 'coalesced' : 'ink-managed',
    ...(override ? { override } : {})
  };
}

export function formatTerminalCapabilityProfile(
  profile: TerminalCapabilityProfile,
  diagnostics?: TuiRenderDiagnostics
): string {
  const lines = [
    'TUI status',
    `  Terminal:      ${profile.host}${profile.embedded ? ' (embedded)' : ''}`,
    `  Renderer:      ${profile.renderer}${profile.override ? ' (environment override)' : ''}`,
    `  Frame rate:    ${profile.maxFps} FPS maximum (configured: ${profile.configuredFrameRate})`,
    `  Text cadence:  ${profile.textFrameIntervalMs} ms`,
    `  Resize settle: ${profile.resizeDebounceMs} ms`,
    `  React commit:  ${profile.concurrentRendering ? 'concurrent' : 'synchronous'}`,
    `  Keyboard:      ${profile.kittyKeyboard ? 'Kitty protocol' : 'legacy'}; newline ${profile.shiftEnter}`,
    `  Mouse:         ${profile.mouseTracking ? 'SGR tracking enabled' : 'disabled'}`,
    `  Wheel input:   ${profile.wheelInput === 'arrow-fallback' ? 'arrow fallback; history Ctrl+P/Ctrl+N' : 'mouse reports'}`,
    `  Sync output:   ${profile.synchronizedOutput === 'coalesced' ? 'coalesced embedded-terminal frames' : 'Ink-managed DEC synchronized frame commits'}`,
    '  Override:      set SYZZZ_TUI_PROFILE=standard|conservative before launch'
  ];
  if (diagnostics) {
    const average = diagnostics.frames === 0 ? 0 : diagnostics.totalRenderMs / diagnostics.frames;
    lines.push(
      `  Frames:        ${diagnostics.frames}`,
      `  Render time:   ${diagnostics.lastRenderMs.toFixed(1)} ms last / ${average.toFixed(1)} ms average / ${diagnostics.maximumRenderMs.toFixed(1)} ms max`
    );
  }
  return lines.join('\n');
}
