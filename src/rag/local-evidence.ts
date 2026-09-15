import { z } from 'zod';
import { readUtf8Range, type ReadSourceSnapshot } from '../tools/read-range.js';
import { resolveWorkspacePath } from '../tools/workspace.js';
import { throwIfAborted } from '../tools/abort.js';

const snapshotSchema = z
  .object({
    kind: z.literal('file-read'),
    path: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.includes('\\') &&
          !value.startsWith('/') &&
          !value.includes(':') &&
          !value.split('/').includes('..')
      ),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    text: z.string().max(4096)
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine && value.endLine - value.startLine < 2000);

export interface LocalReadEvidence extends ReadSourceSnapshot {
  id: string;
}

// Only structured successful Read results enter here, never model-written prose or history.
export class LocalReadEvidenceStore {
  private readonly entries: ReadSourceSnapshot[] = [];

  capture(value: unknown): boolean {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success || Buffer.byteLength(parsed.data.text, 'utf8') > 4096) return false;
    const entry = parsed.data;
    const index = this.entries.findIndex(
      (item) => item.path === entry.path && item.startLine === entry.startLine
    );
    const next = this.entries.filter((_, i) => i !== index);
    if (
      next.length >= 4 ||
      next.reduce((n, item) => n + Buffer.byteLength(item.text, 'utf8'), 0) +
        Buffer.byteLength(entry.text, 'utf8') >
        8192
    )
      return false;
    if (index >= 0) this.entries[index] = entry;
    else this.entries.push(entry);
    return true;
  }

  get size(): number {
    return this.entries.length;
  }

  async validate(
    workspace: string,
    signal: AbortSignal
  ): Promise<{ evidence: LocalReadEvidence[]; invalid: boolean }> {
    const evidence: LocalReadEvidence[] = [];
    let invalid = false;
    for (const [index, entry] of this.entries.entries()) {
      throwIfAborted(signal);
      try {
        const path = await resolveWorkspacePath(entry.path, workspace, 'read');
        const current = await readUtf8Range(
          path,
          entry.path,
          entry.startLine,
          entry.endLine - entry.startLine + 1,
          true,
          signal
        );
        if (current.data?.sourceHash !== entry.sourceHash || current.data?.text !== entry.text) {
          invalid = true;
          continue;
        }
        evidence.push({ ...entry, id: `local-read-${index + 1}` });
      } catch {
        throwIfAborted(signal);
        invalid = true;
      }
    }
    return { evidence, invalid };
  }
}
