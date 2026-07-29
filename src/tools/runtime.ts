import { z } from 'zod';
import type {
  ToolDefinition,
  ToolResult,
  TypedToolDefinition
} from '../types.js';

export function defineTool<Input, Output = unknown>(
  definition: TypedToolDefinition<Input, Output>
): ToolDefinition {
  return {
    ...definition,
    inputSchema: definition.inputSchema as z.ZodType<unknown>,
    resolvePolicy: definition.resolvePolicy
      ? async (input, context) =>
          definition.resolvePolicy!(input as Input, context)
      : undefined,
    prepareApproval: definition.prepareApproval
      ? async (input, context) => definition.prepareApproval!(input as Input, context)
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

  const issueDescriptions = validationResult.error.issues.map(issue => {
    const issuePath = issue.path.length > 0 ? issue.path.join('.') : 'input';
    return `${issuePath}: ${issue.message}`;
  });

  return {
    success: false,
    message: `Invalid tool input: ${issueDescriptions.join('; ')}`
  };
}

export function convertToolSchemaToJsonSchema(tool: ToolDefinition): {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
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
    ...(Array.isArray(required)
      ? { required: required.filter(item => typeof item === 'string') as string[] }
      : {})
  };
}
