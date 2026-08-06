import { z } from 'zod';
import type { ToolDefinition, UserInputAnswers, UserQuestion } from '../types.js';
import { defineTool } from './runtime.js';

export const MAX_ASK_USER_CALLS_PER_TURN = 2;
export const MAX_USER_ANSWER_CHARACTERS = 4 * 1024;

const questionOptionSchema = z
  .object({
    value: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(200).optional()
  })
  .strict();

const questionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    header: z.string().trim().min(1).max(32),
    prompt: z.string().trim().min(1).max(500),
    kind: z.enum(['single', 'multi', 'text']),
    options: z.array(questionOptionSchema).min(2).max(6).optional(),
    allowCustom: z.boolean().optional().default(true)
  })
  .strict()
  .superRefine((question, context) => {
    if (question.kind === 'text' && question.options !== undefined) {
      context.addIssue({ code: 'custom', message: 'Text questions cannot define options' });
    }
    if (question.kind !== 'text' && question.options === undefined) {
      context.addIssue({ code: 'custom', message: 'Choice questions must define options' });
    }
    if (question.options) {
      const values = question.options.map((option) => option.value);
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: 'custom', message: 'Question option values must be unique' });
      }
    }
  });

export const askUserInputSchema = z
  .object({
    questions: z.array(questionSchema).min(1).max(3)
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Question IDs must be unique' });
    }
  });

export type AskUserInput = z.infer<typeof askUserInputSchema>;

export function validateUserInputAnswers(
  questions: readonly UserQuestion[],
  answers: UserInputAnswers
): UserInputAnswers {
  const normalized: UserInputAnswers = {};
  for (const question of questions) {
    const answer = answers[question.id];
    if (question.kind === 'text') {
      if (
        typeof answer !== 'string' ||
        answer.trim().length === 0 ||
        answer.length > MAX_USER_ANSWER_CHARACTERS
      ) {
        throw new Error(`Invalid text answer for ${question.id}`);
      }
      normalized[question.id] = answer;
      continue;
    }

    const allowed = new Set(question.options?.map((option) => option.value) ?? []);
    // The Agent may suggest choices, but it cannot prevent the user from
    // supplying a bounded answer in their own words.
    const validCustom = (value: string) =>
      value.trim().length > 0 && value.length <= MAX_USER_ANSWER_CHARACTERS;
    if (question.kind === 'single') {
      if (typeof answer !== 'string' || (!allowed.has(answer) && !validCustom(answer))) {
        throw new Error(`Invalid selected answer for ${question.id}`);
      }
      normalized[question.id] = answer;
      continue;
    }

    if (
      !Array.isArray(answer) ||
      answer.length === 0 ||
      new Set(answer).size !== answer.length ||
      answer.some((value) => !allowed.has(value) && !validCustom(value))
    ) {
      throw new Error(`Invalid multi-select answer for ${question.id}`);
    }
    normalized[question.id] = [...answer];
  }
  return normalized;
}

export const askUserTool: ToolDefinition = defineTool({
  name: 'AskUser',
  description:
    'Open the interactive UI for one to three bounded clarification questions or workflow choices. When an activated Skill or workflow needs a material user choice, you MUST use this tool instead of printing a pseudo-menu or question list. It cannot grant permissions or change runtime policy.',
  inputSchema: askUserInputSchema,
  risk: 'read',
  approval: 'never',
  modeAccess: 'all-modes',
  async execute() {
    throw new Error('AskUser must be executed by the interactive runtime');
  }
});
