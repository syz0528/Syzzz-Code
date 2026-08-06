import type { UiMode } from './config.js';

export interface UiCapabilities {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  ci: boolean;
  dumbTerminal: boolean;
  screenReader: boolean;
}

export function detectUiCapabilities(environment: NodeJS.ProcessEnv = process.env): UiCapabilities {
  return {
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    ci: Boolean(environment.CI),
    dumbTerminal: environment.TERM?.toLowerCase() === 'dumb',
    screenReader: environment.INK_SCREEN_READER?.toLowerCase() === 'true'
  };
}

export function resolveUiMode(requested: UiMode, capabilities: UiCapabilities): 'tui' | 'inline' {
  if (requested === 'inline') {
    return 'inline';
  }
  const available =
    capabilities.stdinTTY &&
    capabilities.stdoutTTY &&
    !capabilities.ci &&
    !capabilities.dumbTerminal &&
    !capabilities.screenReader;
  if (requested === 'tui' && !available) {
    throw new Error(
      'TUI mode requires interactive stdin/stdout, TERM other than dumb, and screen-reader mode disabled'
    );
  }
  return available ? 'tui' : 'inline';
}
