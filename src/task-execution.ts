import { posix } from 'node:path';

type Outcome = 'success' | 'error' | 'denied' | 'cancelled';
interface ExecutionFact {
  tool: string;
  outcome: Outcome;
  path?: string;
}

function normalize(path: string): string {
  return posix.normalize(path.replace(/\\/g, '/').replace(/^\.\//, ''));
}

// These are syntactic file mentions, not inferred requests or permission grants.
export function mentionedTaskFiles(message: string): string[] {
  const matches = message.matchAll(
    /(?:^|[\s`"'(（])((?:[A-Za-z]:[\\/])?(?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|txt|go|rs|cpp|cc|c|h|java|sh))(?=$|[\s`"'),.，。；;:：!?！？)）])/giu
  );
  return [
    ...new Set([...matches].map((match) => match[1]).filter((path) => path.length <= 256))
  ].slice(0, 4);
}

export class TaskExecutionLedger {
  readonly mentions: readonly string[];
  private readonly facts: ExecutionFact[] = [];
  private readonly attemptedReads = new Set<string>();
  private ragAttempted = false;
  private denied = false;
  private reviewed = false;

  constructor(userMessage: string) {
    this.mentions = mentionedTaskFiles(userMessage);
  }

  observe(tool: string, input: unknown, outcome: Outcome): void {
    if (tool === 'RagSearch' || tool === 'RagRead' || tool === 'AutoRagRead')
      this.ragAttempted = true;
    if (outcome === 'denied' || outcome === 'cancelled') this.denied = true;
    const path =
      tool === 'Read' &&
      input &&
      typeof input === 'object' &&
      'path' in input &&
      typeof input.path === 'string'
        ? input.path
        : undefined;
    if (path && outcome !== 'denied' && outcome !== 'cancelled')
      this.attemptedReads.add(normalize(path));
    if (this.facts.length < 16)
      this.facts.push({
        tool: tool.slice(0, 64),
        outcome,
        ...(path ? { path: path.slice(0, 256) } : {})
      });
  }

  get active(): boolean {
    return this.ragAttempted && this.mentions.length > 0;
  }

  takeFinalizationReview(): boolean {
    if (
      !this.active ||
      this.denied ||
      this.reviewed ||
      this.mentions.every((path) => this.attemptedReads.has(normalize(path)))
    )
      return false;
    this.reviewed = true;
    return true;
  }

  instructions(): string | undefined {
    if (!this.active) return undefined;
    return [
      'Current-turn execution facts (not a new task or authorization):',
      JSON.stringify({ mentionedFiles: this.mentions, observations: this.facts }),
      'File mentions are NOT inferred obligations: they may be examples, remote sources, or forbidden targets. Use the original user request to decide.',
      'RAG evidence availability does not decide whether a local file is readable. A successful Read proves only the returned range was read, not that analysis or tests passed. Failed reads are limitations, not success; do not repeat denied operations.',
      'For a requested combined task, finish each authorized part or explicitly state its actual limitation. Do not finalize solely because RagRead succeeded. Cite RAG only for claims supported by that evidence, not for local file observations.',
      ...(this.reviewed
        ? [
            'One-time completion review: before finalizing, compare the original request with these facts. Some mentioned files have no Read attempt. If local inspection was actually requested and permitted, perform it; otherwise do not add work. Do not claim unperformed steps complete. No second completion reminder will be given.'
          ]
        : [])
    ].join('\n');
  }
}
