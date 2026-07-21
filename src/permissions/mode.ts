export const PERMISSION_MODES = ['safe', 'acceptEdits', 'fullAccess'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'safe';

const MODE_ALIASES: Record<string, PermissionMode> = {
  safe: 'safe',
  default: 'safe',
  acceptedits: 'acceptEdits',
  accept: 'acceptEdits',
  'auto-edit': 'acceptEdits',
  autoedit: 'acceptEdits',
  fullaccess: 'fullAccess',
  full: 'fullAccess',
  yolo: 'fullAccess'
};

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Parse a user-facing mode token (including aliases) into a PermissionMode.
 * Returns null when the token is not recognized.
 */
export function parsePermissionMode(value: string): PermissionMode | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return MODE_ALIASES[normalized] ?? null;
}

export function permissionModeTitle(mode: PermissionMode): string {
  switch (mode) {
    case 'safe':
      return 'Safe';
    case 'acceptEdits':
      return 'Accept Edits';
    case 'fullAccess':
      return 'Full Access';
  }
}

export function permissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'safe':
      return 'Read/ListDirectory auto; Write/Edit/Shell require approval each time.';
    case 'acceptEdits':
      return 'Read/ListDirectory/Write/Edit auto in workspace; Shell still requires approval.';
    case 'fullAccess':
      return 'All tools skip approval prompts this session. File tools stay workspace-bound; Shell still has full account privileges.';
  }
}

export function formatPermissionModesHelp(currentMode: PermissionMode): string {
  const lines = [
    `Current permission mode: ${permissionModeTitle(currentMode)} (${currentMode})`,
    '',
    'Available modes (session only; resets to safe when the process exits):',
    `  safe         ${permissionModeDescription('safe')}`,
    `  acceptEdits  ${permissionModeDescription('acceptEdits')}`,
    `  fullAccess   ${permissionModeDescription('fullAccess')}`,
    '',
    'Usage:',
    '  /permissions',
    '  /permissions safe',
    '  /permissions acceptEdits',
    '  /permissions fullAccess',
    '',
    'Aliases: accept, auto-edit → acceptEdits; full, yolo → fullAccess',
    '',
    'Full Access requires an explicit y confirmation.'
  ];
  return lines.join('\n');
}
