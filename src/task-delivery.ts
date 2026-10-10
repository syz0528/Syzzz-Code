import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { resolveWorkspacePath } from './tools/workspace.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTRACT_BYTES = 32 * 1024;
const MAX_CHECK_HINT_BYTES = 2 * 1024;
const MAX_LOCATION_HINT_BYTES = 2 * 1024;
const relativePath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !/[\x00-\x1f:]/u.test(value) &&
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !value
        .replaceAll('\\', '/')
        .split('/')
        .some((part) => !part || part === '..' || part === '.')
  )
  .transform((value) => value.replaceAll('\\', '/'));
const common = {
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  label: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^\x00-\x1f\x7f]*$/u)
};
const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('read'), path: relativePath }).strict(),
  z
    .object({
      ...common,
      kind: z.literal('artifact'),
      path: relativePath,
      contains: z.array(z.string().min(1).max(256)).max(8).optional()
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('check'),
      command: z.string().min(1).max(1024),
      paths: z.array(relativePath).min(1).max(16),
      outputContains: z.array(z.string().min(1).max(256)).max(8).optional()
    })
    .strict()
]);
const contractSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[^\x00-\x1f\x7f]*$/u),
    requirements: z.array(requirementSchema).min(1).max(8),
    protectedPaths: z.array(relativePath).max(16).default([])
  })
  .strict()
  .superRefine((contract, context) => {
    if (new Set(contract.requirements.map(({ id }) => id)).size !== contract.requirements.length)
      context.addIssue({ code: 'custom', message: 'Task requirement IDs must be unique' });
    const paths = new Set([
      ...contract.requirements.flatMap(requirementPaths),
      ...contract.protectedPaths
    ]);
    if (paths.size > 32)
      context.addIssue({ code: 'custom', message: 'Task scope exceeds 32 files' });
  });

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const stateSchema = z.enum([
  'planned',
  'read',
  'artifact',
  'checked',
  'blocked',
  'unknown',
  'stale'
]);
const outcomeSchema = z.enum(['idle', 'active', 'completed', 'incomplete', 'failed', 'cancelled']);
const protectionSchema = z.enum(['unchanged', 'changed', 'unknown']);
const receiptSchema = z
  .object({
    toolCallId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128).optional(),
    tool: z.enum(['Read', 'Write', 'Edit', 'Patch', 'Shell']),
    outcome: z.enum(['success', 'error', 'denied', 'cancelled']),
    timestamp: z.string().datetime({ offset: true }),
    versions: z.record(relativePath, hashSchema).refine((value) => Object.keys(value).length <= 16)
  })
  .strict();
const pendingOperationSchema = z
  .object({
    toolCallId: z.string().min(1).max(128),
    tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u),
    fingerprint: hashSchema,
    state: z.enum(['pending', 'unknown']),
    timestamp: z.string().datetime({ offset: true })
  })
  .strict();
export const taskDeliveryStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: hashSchema,
    contract: contractSchema,
    items: z
      .array(
        z
          .object({
            ...common,
            kind: z.enum(['read', 'artifact', 'check']),
            state: stateSchema,
            reason: z
              .enum([
                'error',
                'denied',
                'cancelled',
                'incomplete-receipt',
                'check-scope-unverified',
                'partial-or-changed-read',
                'artifact-shape-unverified',
                'file-version-changed',
                'operation-unconfirmed'
              ])
              .optional(),
            receipt: receiptSchema.optional()
          })
          .strict()
      )
      .min(1)
      .max(8),
    baselines: z
      .record(relativePath, hashSchema)
      .refine((value) => Object.keys(value).length <= 16),
    outcome: outcomeSchema,
    protection: protectionSchema,
    operations: z.array(pendingOperationSchema).max(16)
  })
  .strict()
  .refine(
    (saved) => Buffer.byteLength(JSON.stringify(saved)) <= 128 * 1024,
    'Task delivery state exceeds 128 KiB'
  )
  .superRefine((saved, context) => {
    const requirements = saved.contract.requirements;
    const invalid =
      saved.items.length !== requirements.length ||
      saved.items.some((item, index) => {
        const requirement = requirements[index];
        if (
          !requirement ||
          item.id !== requirement.id ||
          item.kind !== requirement.kind ||
          item.label !== requirement.label
        )
          return true;
        const scope = requirementPaths(requirement);
        if (
          item.receipt &&
          Object.keys(item.receipt.versions).some((file) => !scope.includes(file))
        )
          return true;
        if (['read', 'artifact', 'checked'].includes(item.state)) {
          const expected = { read: 'read', artifact: 'artifact', check: 'checked' }[item.kind];
          return (
            item.state !== expected ||
            item.receipt?.outcome !== 'success' ||
            (item.kind === 'read' && item.receipt.tool !== 'Read') ||
            (item.kind === 'check' && item.receipt.tool !== 'Shell') ||
            (item.kind === 'artifact' && item.receipt.tool === 'Read') ||
            scope.some((file) => !item.receipt?.versions[file])
          );
        }
        return false;
      }) ||
      saved.contract.protectedPaths.some((file) => !saved.baselines[file]) ||
      Object.keys(saved.baselines).some((file) => !saved.contract.protectedPaths.includes(file)) ||
      new Set(saved.operations.map(({ toolCallId }) => toolCallId)).size !==
        saved.operations.length;
    if (invalid) context.addIssue({ code: 'custom', message: 'Inconsistent task delivery state' });
  });
export type TaskDeliveryStateV1 = z.infer<typeof taskDeliveryStateSchema>;
type PendingOperation = z.infer<typeof pendingOperationSchema>;

export type TaskDeliveryContract = z.infer<typeof contractSchema>;
export type DeliveryState =
  'planned' | 'read' | 'artifact' | 'checked' | 'blocked' | 'unknown' | 'stale';
export interface DeliveryReceipt {
  toolCallId: string;
  turnId?: string;
  tool: string;
  outcome: string;
  timestamp: string;
  versions: Record<string, string>;
}
export interface DeliveryItem {
  id: string;
  label: string;
  kind: 'read' | 'artifact' | 'check';
  state: DeliveryState;
  reason?: string;
  receipt?: DeliveryReceipt;
}
export interface TaskDeliverySnapshot {
  schemaVersion: 1;
  title: string;
  outcome: 'idle' | 'active' | 'completed' | 'incomplete' | 'failed' | 'cancelled';
  satisfied: boolean;
  items: DeliveryItem[];
  protection: 'unchanged' | 'changed' | 'unknown';
  restored?: boolean;
  needsReconciliation?: boolean;
  unresolvedOperations?: Array<Pick<PendingOperation, 'toolCallId' | 'tool' | 'state'>>;
}
interface FileVersion {
  hash?: string;
  text?: string;
  missing?: boolean;
}
export interface DeliveryObservation {
  toolCallId: string;
  turnId?: string;
  tool: string;
  input: unknown;
  outcome: 'success' | 'error' | 'denied' | 'cancelled';
  metadata?: Record<string, unknown>;
  result?: string;
}

function inputObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}
function normalizedPath(value: unknown): string | undefined {
  const parsed = relativePath.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function requirementPaths(requirement: TaskDeliveryContract['requirements'][number]): string[] {
  return requirement.kind === 'check' ? requirement.paths : [requirement.path];
}
function workspaceShell(input: Record<string, unknown>): boolean {
  const directory = inputObject(input.workingDirectory);
  return input.workingDirectory === undefined || directory.type === 'workspace';
}

function workspaceIdentity(root: string): string {
  const path = resolve(root).replaceAll('\\', '/');
  return createHash('sha256')
    .update(process.platform === 'win32' ? path.toLowerCase() : path)
    .digest('hex');
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, ordered(entry)])
    );
  return value;
}
async function toolPaths(root: string, input: Record<string, unknown>): Promise<string[]> {
  if (typeof input.path !== 'string') return [];
  try {
    const resolved = await resolveWorkspacePath(input.path, root, 'write');
    const single = normalizedPath(relative(root, resolved).replaceAll('\\', '/'));
    return single ? [single] : [];
  } catch {
    return [];
  }
}
function truncated(metadata?: Record<string, unknown>): boolean {
  return [
    'outputTruncated',
    'truncated',
    'longLinesTruncated',
    'stdoutTruncated',
    'stderrTruncated'
  ].some(
    (key) =>
      metadata?.[key] === true || (typeof metadata?.[key] === 'number' && Number(metadata[key]) > 0)
  );
}

async function readVersion(
  root: string,
  file: string,
  maximumBytes = MAX_FILE_BYTES
): Promise<FileVersion> {
  let handle;
  try {
    const resolved = await resolveWorkspacePath(file, root, 'write');
    const canonical = await realpath(resolved);
    await resolveWorkspacePath(canonical, root, 'read');
    handle = await open(canonical, 'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) return {};
    const buffer = Buffer.alloc(Math.min(maximumBytes + 1, before.size + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await resolveWorkspacePath(file, root, 'read');
    if (
      bytesRead > maximumBytes ||
      before.size !== bytesRead ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      (await realpath(current)) !== canonical
    )
      return {};
    const bytes = buffer.subarray(0, bytesRead);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) return {};
    return { hash: createHash('sha256').update(bytes).digest('hex'), text };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : {};
  } finally {
    await handle?.close();
  }
}

export class TaskDelivery {
  private readonly items: DeliveryItem[];
  private readonly paths: string[];
  private readonly baselines = new Map<string, FileVersion>();
  private readonly beforeTools = new Map<string, Map<string, FileVersion>>();
  private outcome: TaskDeliverySnapshot['outcome'] = 'idle';
  private protection: TaskDeliverySnapshot['protection'] = 'unchanged';
  private readonly operations = new Map<string, PendingOperation>();
  private restored = false;
  private needsReconciliation = false;

  private constructor(
    private readonly root: string,
    private readonly contract: TaskDeliveryContract
  ) {
    this.items = contract.requirements.map(({ id, label, kind }) => ({
      id,
      label,
      kind,
      state: 'planned'
    }));
    this.paths = [
      ...new Set([...contract.requirements.flatMap(requirementPaths), ...contract.protectedPaths])
    ];
  }

  static async create(root: string, input: unknown): Promise<TaskDelivery> {
    const parsed = contractSchema.safeParse(input);
    if (!parsed.success)
      throw new Error(
        `Invalid task delivery contract schema: ${parsed.error.issues[0]?.message ?? 'invalid input'}`
      );
    const contract = parsed.data;
    if (new Set(contract.requirements.map(({ id }) => id)).size !== contract.requirements.length)
      throw new Error('Task requirement IDs must be unique');
    const delivery = new TaskDelivery(root, contract);
    if (delivery.paths.length > 32) throw new Error('Task scope exceeds 32 files');
    for (const file of delivery.paths) await resolveWorkspacePath(file, root, 'write');
    const versions = await delivery.versions();
    for (const file of contract.protectedPaths) {
      const version = versions.get(file);
      if (!version?.hash) throw new Error('Protected files must exist and be bounded UTF-8 files');
      delivery.baselines.set(file, { hash: version.hash });
    }
    return delivery;
  }

  static async load(root: string, file: string): Promise<TaskDelivery> {
    const parsedPath = relativePath.parse(file);
    const version = await readVersion(root, parsedPath, MAX_CONTRACT_BYTES);
    if (version.text === undefined)
      throw new Error('Task contract must be a readable workspace JSON file, at most 32 KiB');
    let contract: unknown;
    try {
      contract = JSON.parse(version.text);
    } catch {
      throw new Error('Invalid task contract JSON');
    }
    return TaskDelivery.create(root, contract);
  }

  static restore(root: string, input: unknown): TaskDelivery {
    const saved = taskDeliveryStateSchema.parse(input);
    if (saved.workspaceId !== workspaceIdentity(root))
      throw new Error('Task delivery workspace mismatch');
    const delivery = new TaskDelivery(root, saved.contract);
    delivery.items.splice(0, delivery.items.length, ...structuredClone(saved.items));
    for (const [file, hash] of Object.entries(saved.baselines))
      delivery.baselines.set(file, { hash });
    delivery.outcome = saved.outcome === 'active' ? 'incomplete' : saved.outcome;
    delivery.protection = saved.protection;
    delivery.restored = true;
    delivery.needsReconciliation = true;
    for (const operation of saved.operations)
      delivery.operations.set(operation.toolCallId, { ...operation, state: 'unknown' });
    if (delivery.operations.size > 0) delivery.outcome = 'incomplete';
    return delivery;
  }

  exportState(): TaskDeliveryStateV1 {
    return taskDeliveryStateSchema.parse({
      schemaVersion: 1,
      workspaceId: workspaceIdentity(this.root),
      contract: structuredClone(this.contract),
      items: structuredClone(this.items),
      baselines: Object.fromEntries(
        [...this.baselines].map(([file, version]) => [file, version.hash])
      ),
      outcome: this.outcome,
      protection: this.protection,
      operations: [...this.operations.values()].map((operation) => ({ ...operation }))
    });
  }

  private async fingerprint(tool: string, value: unknown): Promise<string> {
    const input = { ...inputObject(value) };
    if (['Read', 'Write', 'Edit', 'Patch'].includes(tool) && typeof input.path === 'string') {
      const resolved = await resolveWorkspacePath(input.path, this.root, 'write');
      input.path = relative(this.root, resolved).replaceAll('\\', '/');
      if (process.platform === 'win32') input.path = String(input.path).toLowerCase();
    }
    if (tool === 'Shell' && workspaceShell(input)) input.workingDirectory = { type: 'workspace' };
    return createHash('sha256')
      .update(JSON.stringify(ordered({ tool, input })))
      .digest('hex');
  }

  async assertOperationAllowed(tool: string, input: unknown): Promise<void> {
    const fingerprint = await this.fingerprint(tool, input);
    const unresolved =
      [...this.operations.values()].find((operation) => operation.fingerprint === fingerprint) ??
      this.operations.values().next().value;
    if (unresolved)
      throw new Error(
        `Unresolved prior operation ${unresolved.toolCallId} (${unresolved.tool}). Inspect its effects and use /task resolve ${unresolved.toolCallId}; do not retry or bypass it.`
      );
  }

  async beginOperation(toolCallId: string, tool: string, input: unknown): Promise<void> {
    await this.assertOperationAllowed(tool, input);
    const operation = pendingOperationSchema.parse({
      toolCallId,
      tool,
      fingerprint: await this.fingerprint(tool, input),
      state: 'pending',
      timestamp: new Date().toISOString()
    });
    if (this.operations.has(toolCallId)) throw new Error('Duplicate task operation ID');
    this.operations.set(toolCallId, operation);
  }

  async resolveOperation(toolCallId: string): Promise<TaskDeliverySnapshot> {
    if (!this.operations.delete(toolCallId))
      throw new Error('No unresolved task operation matches that ID');
    this.outcome = 'incomplete';
    return this.reconcile();
  }

  contextSummary(): string {
    const snapshot = this.snapshot();
    const checks: Array<{
      id: string;
      state: DeliveryState;
      input: { command: string };
      paths: string[];
    }> = [];
    const locations: Array<{
      id: string;
      kind: 'read' | 'artifact';
      state: DeliveryState;
      path: string;
    }> = [];
    let checksOmitted = 0;
    let locationsOmitted = 0;
    for (const [index, requirement] of this.contract.requirements.entries()) {
      if (requirement.kind !== 'check') {
        const location = {
          id: requirement.id,
          kind: requirement.kind,
          state: snapshot.items[index].state,
          path: requirement.path
        };
        if (Buffer.byteLength(JSON.stringify([...locations, location])) <= MAX_LOCATION_HINT_BYTES)
          locations.push(location);
        else locationsOmitted++;
        continue;
      }
      const hint = {
        id: requirement.id,
        state: snapshot.items[index].state,
        input: { command: requirement.command },
        paths: requirement.paths
      };
      if (Buffer.byteLength(JSON.stringify([...checks, hint])) <= MAX_CHECK_HINT_BYTES)
        checks.push(hint);
      else checksOmitted++;
    }
    const receiptsSafe =
      !snapshot.needsReconciliation &&
      !snapshot.unresolvedOperations?.length &&
      snapshot.protection === 'unchanged';
    const receiptRequirementsComplete =
      receiptsSafe &&
      snapshot.items.every(({ state }) => ['read', 'artifact', 'checked'].includes(state));
    const focus =
      !receiptsSafe || snapshot.items.some(({ state }) => ['blocked', 'unknown'].includes(state))
        ? 'inspect-blockers'
        : snapshot.items.some(({ kind, state }) => kind === 'read' && state !== 'read')
          ? 'read-sources'
          : snapshot.items.some(({ kind, state }) => kind === 'artifact' && state !== 'artifact')
            ? 'produce-artifacts'
            : snapshot.items.some(({ kind, state }) => kind === 'check' && state !== 'checked')
              ? 'run-checks'
              : 'report';
    return JSON.stringify({
      outcome: snapshot.outcome,
      protection: snapshot.protection,
      items: snapshot.items.map(({ id, kind, state, reason }) => ({ id, kind, state, reason })),
      focus,
      locations,
      ...(locationsOmitted ? { locationsOmitted } : {}),
      checks,
      ...(checksOmitted ? { checksOmitted } : {}),
      receiptRequirementsComplete,
      unresolvedOperations: snapshot.unresolvedOperations ?? []
    });
  }

  private async versions(): Promise<Map<string, FileVersion>> {
    const versions = new Map<string, FileVersion>();
    for (const file of this.paths) versions.set(file, await readVersion(this.root, file));
    return versions;
  }

  startTurn(): void {
    this.outcome = 'active';
  }

  async beforeTool(toolCallId: string, tool: string): Promise<void> {
    if (['Read', 'Write', 'Edit', 'Patch', 'Shell'].includes(tool)) {
      const versions = await this.versions();
      this.reconcileVersions(versions);
      for (const [file, version] of versions)
        versions.set(file, { hash: version.hash, missing: version.missing });
      this.beforeTools.set(toolCallId, versions);
    }
  }

  async observe(observation: DeliveryObservation): Promise<void> {
    const { toolCallId, tool, outcome, metadata } = observation;
    const operation = this.operations.get(toolCallId);
    if (operation) {
      if (outcome === 'success' && !truncated(metadata)) this.operations.delete(toolCallId);
      else operation.state = 'unknown';
    }
    if (!['Read', 'Write', 'Edit', 'Patch', 'Shell'].includes(tool)) return;
    const input = inputObject(observation.input);
    const before = this.beforeTools.get(toolCallId);
    this.beforeTools.delete(toolCallId);
    const current = await this.versions();
    // Host schema rejection occurs before execution; keep prior receipts, but recheck disk versions.
    if (
      outcome === 'error' &&
      metadata?.reason === 'invalid-tool-input' &&
      before === undefined &&
      operation === undefined
    ) {
      this.reconcileVersions(current);
      return;
    }
    // A failed, normally exited contract check is a known result, not an unknown execution.
    // Require unchanged bounded scope; arbitrary Shell failures still need manual recovery.
    const confirmedFailedCheck =
      tool === 'Shell' &&
      outcome === 'error' &&
      workspaceShell(input) &&
      metadata?.completionReason === 'exited' &&
      Number.isSafeInteger(metadata.exitCode) &&
      Number(metadata.exitCode) > 0 &&
      !truncated(metadata) &&
      this.protection === 'unchanged' &&
      this.contract.requirements.some((r) => r.kind === 'check' && r.command === input.command) &&
      before !== undefined &&
      this.paths.every((file) => {
        const previous = before.get(file);
        const next = current.get(file);
        return (
          Boolean(previous?.hash && previous.hash === next?.hash) ||
          (previous?.missing === true && next?.missing === true)
        );
      });
    if (operation && confirmedFailedCheck) this.operations.delete(toolCallId);
    const touched = await toolPaths(this.root, input);
    for (let index = 0; index < this.items.length; index++) {
      const requirement = this.contract.requirements[index];
      const item = this.items[index];
      const isCheck =
        requirement.kind === 'check' &&
        tool === 'Shell' &&
        workspaceShell(input) &&
        input.command === requirement.command;
      const changedByShell =
        requirement.kind === 'artifact' &&
        tool === 'Shell' &&
        workspaceShell(input) &&
        Boolean(before?.get(requirement.path)?.hash || before?.get(requirement.path)?.missing) &&
        before?.get(requirement.path)?.hash !== current.get(requirement.path)?.hash;
      const affected =
        isCheck ||
        changedByShell ||
        (requirement.kind !== 'check' &&
          touched.includes(requirement.path) &&
          (requirement.kind === 'read'
            ? tool === 'Read'
            : ['Write', 'Edit', 'Patch'].includes(tool)));
      if (!affected) continue;
      const versions: Record<string, string> = {};
      for (const file of requirementPaths(requirement)) {
        const hash = current.get(file)?.hash;
        if (hash) versions[file] = hash;
      }
      item.receipt = {
        toolCallId,
        ...(observation.turnId ? { turnId: observation.turnId } : {}),
        tool,
        outcome,
        timestamp: new Date().toISOString(),
        versions
      };
      if (outcome !== 'success') {
        item.state = outcome === 'cancelled' ? 'unknown' : 'blocked';
        item.reason = outcome;
      } else if (!before || truncated(metadata)) {
        item.state = 'unknown';
        item.reason = 'incomplete-receipt';
      } else if (requirement.kind === 'check') {
        const stable = requirement.paths.every(
          (file) => before.get(file)?.hash && before.get(file)?.hash === current.get(file)?.hash
        );
        const outputMatches =
          requirement.outputContains?.every((text) => observation.result?.includes(text)) !== false;
        item.state =
          metadata?.completionReason === 'exited' &&
          metadata.exitCode === 0 &&
          stable &&
          outputMatches
            ? 'checked'
            : 'unknown';
        item.reason = item.state === 'checked' ? undefined : 'check-scope-unverified';
      } else if (requirement.kind === 'read') {
        const full =
          metadata?.startLine === 1 &&
          metadata.endLine === metadata.totalLines &&
          metadata.versionHash === current.get(requirement.path)?.hash &&
          before.get(requirement.path)?.hash === current.get(requirement.path)?.hash;
        item.state = full ? 'read' : 'unknown';
        item.reason = full ? undefined : 'partial-or-changed-read';
      } else {
        const file = current.get(requirement.path);
        const valid =
          file?.hash && requirement.contains?.every((text) => file.text?.includes(text)) !== false;
        const executed =
          tool !== 'Shell' || (metadata?.completionReason === 'exited' && metadata.exitCode === 0);
        item.state = valid && executed ? 'artifact' : 'unknown';
        item.reason = item.state === 'artifact' ? undefined : 'artifact-shape-unverified';
      }
    }
    this.reconcileVersions(current);
  }

  private reconcileVersions(current: Map<string, FileVersion>): void {
    for (const [file, baseline] of this.baselines) {
      const version = current.get(file);
      if ((version?.hash && version.hash !== baseline.hash) || version?.missing)
        this.protection = 'changed';
      else if (!version?.hash && this.protection !== 'changed') this.protection = 'unknown';
    }
    for (const item of this.items) {
      if (!item.receipt || !['read', 'artifact', 'checked'].includes(item.state)) continue;
      if (
        Object.entries(item.receipt.versions).some(
          ([file, hash]) => current.get(file)?.hash !== hash
        )
      ) {
        item.state = 'stale';
        item.reason = 'file-version-changed';
      }
    }
  }

  async reconcile(): Promise<TaskDeliverySnapshot> {
    this.reconcileVersions(await this.versions());
    this.needsReconciliation = false;
    return this.snapshot();
  }

  markTruncated(toolCallId: string): void {
    for (const item of this.items) {
      if (
        item.receipt?.toolCallId === toolCallId &&
        ['read', 'artifact', 'checked'].includes(item.state)
      ) {
        item.state = 'unknown';
        item.reason = 'incomplete-receipt';
      }
    }
  }

  async finish(
    outcome: 'completed' | 'incomplete' | 'failed' | 'cancelled'
  ): Promise<TaskDeliverySnapshot> {
    this.outcome = outcome;
    for (const operation of this.operations.values()) operation.state = 'unknown';
    for (const [toolCallId] of this.beforeTools) {
      this.beforeTools.delete(toolCallId);
    }
    return this.reconcile();
  }

  snapshot(): TaskDeliverySnapshot {
    return {
      schemaVersion: 1,
      title: this.contract.title,
      outcome: this.outcome,
      satisfied:
        this.outcome === 'completed' &&
        !this.needsReconciliation &&
        this.operations.size === 0 &&
        this.protection === 'unchanged' &&
        this.items.every(({ state }) => ['read', 'artifact', 'checked'].includes(state)),
      items: structuredClone(this.items),
      protection: this.protection,
      ...(this.restored ? { restored: true } : {}),
      ...(this.needsReconciliation ? { needsReconciliation: true } : {}),
      ...(this.operations.size > 0
        ? {
            unresolvedOperations: [...this.operations.values()].map(
              ({ toolCallId, tool, state }) => ({ toolCallId, tool, state })
            )
          }
        : {})
    };
  }
}

export function formatTaskDelivery(
  snapshot: TaskDeliverySnapshot,
  language: 'zh' | 'en' = 'en'
): string {
  const zh = language === 'zh';
  const states: Record<DeliveryState, string> = {
    planned: '未执行',
    read: '已读取',
    artifact: '已有产物',
    checked: '已检查',
    blocked: '受阻',
    unknown: '未知',
    stale: '已过期'
  };
  const protection = { unchanged: '未发现变化', changed: '发现变化', unknown: '无法核对' };
  const outcomes = {
    idle: '尚未启动',
    active: '执行中',
    completed: '回合结束',
    incomplete: '未完成',
    failed: '回合失败',
    cancelled: '已取消'
  };
  const reasons: Record<string, string> = {
    error: '工具失败',
    denied: '操作被拒绝',
    cancelled: '操作取消',
    'incomplete-receipt': '回执不完整或已截断',
    'check-scope-unverified': '检查范围或成功标记无法核对',
    'partial-or-changed-read': '仅部分读取或版本变化',
    'artifact-shape-unverified': '产物结构无法核对',
    'file-version-changed': '对应文件版本已变化'
  };
  return [
    `${zh ? '交付记录' : 'Delivery'}: ${snapshot.title} (${zh ? outcomes[snapshot.outcome] : snapshot.outcome})`,
    ...(snapshot.needsReconciliation
      ? [
          zh
            ? '已载入，等待重新核对当前文件版本；不自动重放操作。'
            : 'Loaded; current file versions need reconciliation. Operations are not replayed.'
        ]
      : snapshot.restored
        ? [
            zh
              ? '已恢复；已按当前文件版本重新核对，不自动重放操作。'
              : 'Restored; reconcile current file versions. Operations are never replayed automatically.'
          ]
        : []),
    ...snapshot.items.map(
      (item) =>
        `  ${item.id}: ${zh ? states[item.state] : item.state} - ${item.label}${item.reason ? ` (${zh ? (reasons[item.reason] ?? item.reason) : item.reason})` : ''}`
    ),
    `${zh ? '保护文件' : 'Protected files'}: ${zh ? protection[snapshot.protection] : snapshot.protection}`,
    ...(snapshot.unresolvedOperations ?? []).map(
      ({ toolCallId, tool }) =>
        `${zh ? '未决操作' : 'Unresolved operation'}: ${toolCallId} (${tool}); /task resolve ${toolCallId}`
    ),
    zh
      ? snapshot.satisfied
        ? '契约检查已满足；不代表全部内容正确。'
        : '尚未形成完整、有效的交付回执。'
      : snapshot.satisfied
        ? 'Contract checks satisfied; not proof of overall correctness.'
        : 'Delivery receipts are incomplete or invalid.'
  ].join('\n');
}
