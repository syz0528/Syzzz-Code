import React from 'react';
import { render } from 'ink';
import type { QueryEngine } from '../engine.js';
import { InteractionController } from '../interaction/controller.js';
import type { InteractiveSessionOptions } from '../interactive.js';
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, TuiApp } from './app.js';
import { encodeOsc52Clipboard } from './clipboard.js';
import {
  inspectTerminalKeyboard,
  probeKittyKeyboardSupport,
  terminalKeyboardPresentation
} from './terminal-keyboard.js';
import {
  createTerminalCapabilityProfile,
  createTuiRenderDiagnostics,
  formatTerminalCapabilityProfile,
  recordTuiRender
} from './terminal-profile.js';

export interface TuiSessionOptions extends InteractiveSessionOptions {
  persistentHistory: boolean;
  promptSessionStartup?: boolean;
}

export interface TuiExitSummary {
  sessionId: string;
  persistence: string;
  reason: string;
}

export async function runTuiSession(
  engine: QueryEngine,
  options: TuiSessionOptions
): Promise<TuiExitSummary> {
  const keyboardStatus = await inspectTerminalKeyboard().catch(() => ({
    host: 'unknown' as const,
    setupAvailable: false,
    setupInstalled: false
  }));
  const kittySupported = await probeKittyKeyboardSupport().catch(() => false);
  const keyboard = terminalKeyboardPresentation(kittySupported, keyboardStatus);
  const profile = createTerminalCapabilityProfile({
    keyboardStatus,
    keyboard,
    kittySupported,
    configuredFrameRate: options.uiFrameRate ?? 'auto'
  });
  const renderDiagnostics = createTuiRenderDiagnostics();
  const controller = await InteractionController.create({
    engine,
    sessionOptions: {
      ...options,
      uiDiagnostics: () => formatTerminalCapabilityProfile(profile, renderDiagnostics)
    },
    persistentHistory: options.persistentHistory,
    streamOutput: options.streamOutput ?? true,
    textFrameIntervalMs: profile.textFrameIntervalMs
  });
  const handleTerminate = () => controller.requestExit('signal');
  const handleInterrupt = () => {
    if (!controller.abortCurrent()) {
      controller.requestExit('signal');
    }
  };
  process.once('SIGTERM', handleTerminate);
  process.once('SIGINT', handleInterrupt);
  let startupController: AbortController | undefined;
  try {
    if (process.stdout.isTTY && profile.mouseTracking) {
      process.stdout.write(ENABLE_MOUSE_TRACKING);
    }
    const instance = render(
      <TuiApp
        controller={controller}
        copyToClipboard={(text) => {
          if (!process.stdout.isTTY) throw new Error('Terminal clipboard is unavailable');
          process.stdout.write(encodeOsc52Clipboard(text));
        }}
        keyboard={keyboard}
        profile={profile}
      />,
      {
        alternateScreen: true,
        concurrent: true,
        exitOnCtrlC: false,
        incrementalRendering: true,
        maxFps: profile.maxFps,
        onRender: ({ renderTime }) => recordTuiRender(renderDiagnostics, renderTime),
        patchConsole: false,
        ...(kittySupported
          ? {
              kittyKeyboard: {
                mode: 'enabled' as const,
                flags: ['disambiguateEscapeCodes' as const]
              }
            }
          : {})
      }
    );
    if (options.promptSessionStartup) {
      startupController = new AbortController();
      void controller.promptSessionStartup(startupController.signal).catch((error) => {
        if (!startupController?.signal.aborted) {
          controller.notice({
            tone: 'warning',
            text: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
    await instance.waitUntilExit();
    const snapshot = controller.getSnapshot();
    return {
      sessionId: snapshot.status.sessionId,
      persistence: snapshot.status.persistence.state,
      reason: snapshot.exitReason ?? 'completed'
    };
  } finally {
    startupController?.abort();
    if (process.stdout.isTTY && profile.mouseTracking) {
      process.stdout.write(DISABLE_MOUSE_TRACKING);
    }
    process.removeListener('SIGTERM', handleTerminate);
    process.removeListener('SIGINT', handleInterrupt);
    await controller.close();
  }
}
