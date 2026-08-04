export function resolveUiMode(requested, capabilities) {
  if (requested !== 'auto' && requested !== 'tui' && requested !== 'inline') {
    throw new Error(`Unknown UI mode: ${requested}`);
  }
  if (requested === 'inline') {
    return 'inline';
  }
  const tuiAvailable =
    capabilities.stdinTTY &&
    capabilities.stdoutTTY &&
    !capabilities.nonInteractive &&
    !capabilities.screenReader;
  if (requested === 'tui' && !tuiAvailable) {
    throw new Error('TUI mode requires an interactive TTY without screen-reader mode');
  }
  return tuiAvailable ? 'tui' : 'inline';
}
