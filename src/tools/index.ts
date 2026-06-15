import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import type { Tool } from '../types.js';

export const shellTool: Tool = {
  name: 'Shell',
  description: 'Execute shell commands. Use for git, npm, file operations via command line.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute'
      }
    },
    required: ['command']
  },
  execute: async (input: { command: string }) => {
    try {
      const output = execSync(input.command, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd()
      });
      return output || 'Command executed successfully (no output)';
    } catch (error: any) {
      return `Error: ${error.message}\nStderr: ${error.stderr || ''}`;
    }
  }
};

export const readTool: Tool = {
  name: 'Read',
  description: 'Read file contents from the filesystem.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to read'
      }
    },
    required: ['path']
  },
  execute: async (input: { path: string }) => {
    try {
      const content = readFileSync(input.path, 'utf-8');
      return content;
    } catch (error: any) {
      return `Error reading file: ${error.message}`;
    }
  }
};

export const writeTool: Tool = {
  name: 'Write',
  description: 'Write content to a file, creating or overwriting it.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to write to'
      },
      contents: {
        type: 'string',
        description: 'The content to write'
      }
    },
    required: ['path', 'contents']
  },
  execute: async (input: { path: string; contents: string }) => {
    try {
      writeFileSync(input.path, input.contents, 'utf-8');
      return `Successfully wrote to ${input.path}`;
    } catch (error: any) {
      return `Error writing file: ${error.message}`;
    }
  }
};

export const editTool: Tool = {
  name: 'Edit',
  description: 'Edit a file by replacing old_string with new_string.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to edit'
      },
      old_string: {
        type: 'string',
        description: 'The text to replace'
      },
      new_string: {
        type: 'string',
        description: 'The new text'
      }
    },
    required: ['path', 'old_string', 'new_string']
  },
  execute: async (input: { path: string; old_string: string; new_string: string }) => {
    try {
      const content = readFileSync(input.path, 'utf-8');
      if (!content.includes(input.old_string)) {
        return `Error: old_string not found in ${input.path}`;
      }
      const updated = content.replace(input.old_string, input.new_string);
      writeFileSync(input.path, updated, 'utf-8');
      return `Successfully edited ${input.path}`;
    } catch (error: any) {
      return `Error editing file: ${error.message}`;
    }
  }
};

export const allTools: Tool[] = [shellTool, readTool, writeTool, editTool];
