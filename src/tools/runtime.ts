import { z } from 'zod';
import type { ToolDefinition, ToolResult, TypedToolDefinition } from '../types.js';
import { limitUtf8Head } from './output-limits.js';

export function defineTool<Input, Output = unknown>(
  definition: TypedToolDefinition<Input, Output>
): ToolDefinition {
  const { resolvePolicy, prepareApproval } = definition;
  return {
    ...definition,
    inputSchema: definition.inputSchema as z.ZodType<unknown>,
    resolvePolicy: resolvePolicy
      ? async (input, context) => resolvePolicy(input as Input, context)
      : undefined,
    prepareApproval: prepareApproval
      ? async (input, context) => prepareApproval(input as Input, context)
      : undefined,
    execute: async (input, context): Promise<ToolResult> =>
      definition.execute(input as Input, context)
  };
}

export function validateToolInput(
  tool: ToolDefinition,
  input: unknown
): { success: true; data: unknown } | { success: false; message: string } {
  const validationResult = tool.inputSchema.safeParse(input);
  if (validationResult.success) {
    return {
      success: true,
      data: validationResult.data
    };
  }

  const issueDescriptions = validationResult.error.issues.slice(0, 8).map((issue) => {
    const issuePath = issue.path.length > 0 ? issue.path.join('.') : 'input';
    return limitUtf8Head(`${issuePath}: ${issue.message}`, 512).text;
  });
  const hint =
    tool.name === 'Shell'
      ? 'Workspace Shell input: {"command":"<exact requested command>"}. Omit workingDirectory; never send a path string, null, cwd/workdir, cd or wrappers. Only an activated Skill cwd needs {"type":"skill","name":"skill-name"}; {"type":"workspace"} also remains valid.'
      : tool.name === 'Patch'
        ? 'Patch input: {"path":"existing-file","expectedHash":"<SHA-256 from latest Read>","operations":[{"oldText":"exact unique existing text","newText":"replacement"}]}. expectedHash and operations are required; no unified diff, patch string, old_string/new_string or invented fields. Read the current version first. If delivery receipts are already complete, report rather than polish artifacts.'
        : tool.name === 'ListDirectory'
          ? 'ListDirectory root input: {} or {"path":"."}. If path is present use a nonempty string, never empty, null, an array or object. Read known files directly.'
          : '';

  return {
    success: false,
    message:
      limitUtf8Head(
        `Invalid tool input: ${issueDescriptions.join('; ')}${validationResult.error.issues.length > 8 ? '; further issues omitted' : ''}`,
        1400
      ).text +
      '\nValidation did not execute the tool. Correct the input only while tools remain available; a new call still requires normal policy and approval.' +
      (hint ? `\n${hint}` : '')
  };
}

export function convertToolSchemaToJsonSchema(tool: ToolDefinition): {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: false;
} {
  const generatedSchema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  const properties = generatedSchema.properties;
  const required = generatedSchema.required;

  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error(`Tool ${tool.name} must use an object input schema`);
  }

  return {
    type: 'object',
    properties: properties as Record<string, unknown>,
    ...(generatedSchema.additionalProperties === false
      ? { additionalProperties: false as const }
      : {}),
    ...(Array.isArray(required)
      ? { required: required.filter((item) => typeof item === 'string') as string[] }
      : {})
  };
}
