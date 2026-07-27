import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  posix,
  relative,
  resolve
} from 'node:path';
import { parentPort } from 'node:worker_threads';
import { TextDecoder } from 'node:util';
import ts from 'typescript';
import type {
  AnalysisWorkerRequest,
  AnalysisWorkerResult,
  DiagnosticEntry,
  DiagnosticsWorkerRequest,
  DiagnosticsWorkerResult,
  RepoMapFile,
  RepoMapWorkerRequest,
  RepoMapWorkerResult
} from './analysis-worker-client.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOLS_PER_FILE = 50;
const MAX_SYMBOL_CHARACTERS = 300;
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]);

interface FileAnalysis {
  path: string;
  rawImports: string[];
  symbols: string[];
}

interface CachedFileAnalysis {
  mtimeMs: number;
  size: number;
  analysis: FileAnalysis;
}

interface WorkerRequestEnvelope {
  id: string;
  request: AnalysisWorkerRequest;
}

const repoMapCache = new Map<string, CachedFileAnalysis>();
const workspaceRealpathCache = new Map<string, string>();

function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32'
    ? resolved.toLocaleLowerCase()
    : resolved;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function safeAbsolutePath(workspaceRoot: string, relativePath: string): string {
  const target = resolve(workspaceRoot, relativePath);
  if (!isInside(resolve(workspaceRoot), target)) {
    throw new Error(`Analysis path escapes the workspace: ${relativePath}`);
  }
  return target;
}

function scriptKindForPath(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function boundedText(value: string, limit = MAX_SYMBOL_CHARACTERS): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= limit
    ? compact
    : `${compact.slice(0, limit - 3)}...`;
}

function modifierPrefix(
  node: ts.Node,
  sourceFile: ts.SourceFile
): string {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  const allowed = new Set([
    ts.SyntaxKind.ExportKeyword,
    ts.SyntaxKind.DefaultKeyword,
    ts.SyntaxKind.DeclareKeyword,
    ts.SyntaxKind.AsyncKeyword,
    ts.SyntaxKind.AbstractKeyword
  ]);
  const text = modifiers
    ?.filter(modifier => allowed.has(modifier.kind))
    .map(modifier => modifier.getText(sourceFile))
    .join(' ');
  return text ? `${text} ` : '';
}

function typeParametersText(
  node: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> },
  sourceFile: ts.SourceFile
): string {
  return node.typeParameters?.length
    ? `<${node.typeParameters.map(parameter =>
      boundedText(parameter.getText(sourceFile), 80)
    ).join(', ')}>`
    : '';
}

function extractTopLevelSymbols(sourceFile: ts.SourceFile): string[] {
  const symbols: string[] = [];
  const add = (value: string) => {
    if (symbols.length < MAX_SYMBOLS_PER_FILE) {
      symbols.push(boundedText(value));
    }
  };

  for (const statement of sourceFile.statements) {
    const prefix = modifierPrefix(statement, sourceFile);
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const parameters = statement.parameters
        .map(parameter => boundedText(parameter.getText(sourceFile), 100))
        .join(', ');
      const returnType = statement.type
        ? `: ${boundedText(statement.type.getText(sourceFile), 100)}`
        : '';
      add(
        `${prefix}function ${statement.name.text}` +
        `${typeParametersText(statement, sourceFile)}(${parameters})${returnType}`
      );
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      const heritage = statement.heritageClauses?.length
        ? ` ${statement.heritageClauses
          .map(clause => boundedText(clause.getText(sourceFile), 120))
          .join(' ')}`
        : '';
      add(
        `${prefix}class ${statement.name.text}` +
        `${typeParametersText(statement, sourceFile)}${heritage}`
      );
      continue;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      const heritage = statement.heritageClauses?.length
        ? ` ${statement.heritageClauses
          .map(clause => boundedText(clause.getText(sourceFile), 120))
          .join(' ')}`
        : '';
      add(
        `${prefix}interface ${statement.name.text}` +
        `${typeParametersText(statement, sourceFile)}${heritage}`
      );
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      add(
        `${prefix}type ${statement.name.text}` +
        `${typeParametersText(statement, sourceFile)} = ` +
        boundedText(statement.type.getText(sourceFile), 180)
      );
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      add(`${prefix}enum ${statement.name.text}`);
      continue;
    }
    if (ts.isModuleDeclaration(statement)) {
      add(`${prefix}namespace ${boundedText(statement.name.getText(sourceFile), 100)}`);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const declarationKind = statement.declarationList.flags & ts.NodeFlags.Const
        ? 'const'
        : statement.declarationList.flags & ts.NodeFlags.Let
          ? 'let'
          : 'var';
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.initializer &&
          (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)
          )
        ) {
          const parameters = declaration.initializer.parameters
            .map(parameter => boundedText(parameter.getText(sourceFile), 100))
            .join(', ');
          const returnType = declaration.initializer.type
            ? `: ${boundedText(
              declaration.initializer.type.getText(sourceFile),
              100
            )}`
            : '';
          add(
            `${prefix}${declarationKind} ` +
            `${boundedText(declaration.name.getText(sourceFile), 100)}` +
            ` = (${parameters})${returnType}`
          );
          continue;
        }
        const type = declaration.type
          ? `: ${boundedText(declaration.type.getText(sourceFile), 120)}`
          : '';
        add(
          `${prefix}${declarationKind} ` +
          `${boundedText(declaration.name.getText(sourceFile), 100)}${type}`
        );
      }
    }
  }
  return symbols;
}

function extractImports(sourceFile: ts.SourceFile): string[] {
  const imports = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      imports.add(statement.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      imports.add(statement.moduleReference.expression.text);
    }
  }
  return [...imports];
}

async function analyzeFile(
  workspaceRoot: string,
  relativePath: string
): Promise<{ analysis?: FileAnalysis; cacheHit: boolean }> {
  const path = safeAbsolutePath(workspaceRoot, relativePath);
  const pathLstat = await lstat(path);
  if (!pathLstat.isFile() || pathLstat.isSymbolicLink()) {
    return { cacheHit: false };
  }
  const pathReal = await realpath(path);
  let rootReal = workspaceRealpathCache.get(workspaceRoot);
  if (!rootReal) {
    rootReal = await realpath(workspaceRoot);
    workspaceRealpathCache.set(workspaceRoot, rootReal);
  }
  if (!isInside(rootReal, pathReal)) {
    return { cacheHit: false };
  }
  const pathStat = await stat(path);
  if (pathStat.size > MAX_SOURCE_BYTES) {
    return { cacheHit: false };
  }
  const cacheKey = `${rootReal}\0${normalizeRelativePath(relativePath)}`;
  const cached = repoMapCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === pathStat.mtimeMs &&
    cached.size === pathStat.size
  ) {
    return { analysis: cached.analysis, cacheHit: true };
  }

  const bytes = await readFile(path);
  const finalStat = await stat(path);
  if (
    finalStat.size !== pathStat.size ||
    finalStat.mtimeMs !== pathStat.mtimeMs
  ) {
    throw new Error(`Source file changed during analysis: ${relativePath}`);
  }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(relativePath)
  );
  const analysis: FileAnalysis = {
    path: normalizeRelativePath(relativePath),
    rawImports: extractImports(sourceFile),
    symbols: extractTopLevelSymbols(sourceFile)
  };
  repoMapCache.set(cacheKey, {
    mtimeMs: pathStat.mtimeMs,
    size: pathStat.size,
    analysis
  });
  return { analysis, cacheHit: false };
}

function resolveRelativeImport(
  importerPath: string,
  specifier: string,
  candidates: Set<string>
): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const normalizedBase = posix.normalize(
    posix.join(posix.dirname(importerPath), specifier)
  );
  const importExtension = posix.extname(normalizedBase);
  const withoutRuntimeExtension = ['.js', '.jsx', '.mjs', '.cjs'].includes(
    importExtension
  )
    ? normalizedBase.slice(0, -importExtension.length)
    : normalizedBase;
  const variants = [
    normalizedBase,
    ...[...SOURCE_EXTENSIONS].map(extension => `${normalizedBase}${extension}`),
    ...[...SOURCE_EXTENSIONS].map(extension =>
      `${withoutRuntimeExtension}${extension}`
    ),
    ...[...SOURCE_EXTENSIONS].map(extension => `${normalizedBase}/index${extension}`)
  ];
  return variants.find(path => candidates.has(path));
}

function queryTerms(query: string | undefined): string[] {
  return (query ?? '')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_$./-]+/u)
    .filter(term => term.length > 1);
}

function rankRepoMap(
  analyses: FileAnalysis[],
  query: string | undefined,
  focusPath: string | undefined,
  modifiedPaths: readonly string[],
  maxFiles: number
): RepoMapFile[] {
  const candidatePaths = new Set(analyses.map(analysis => analysis.path));
  const importsByPath = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  for (const analysis of analyses) {
    const imports = analysis.rawImports
      .map(specifier =>
        resolveRelativeImport(analysis.path, specifier, candidatePaths)
      )
      .filter((path): path is string => Boolean(path));
    importsByPath.set(analysis.path, [...new Set(imports)]);
    for (const importedPath of imports) {
      importedBy.set(importedPath, [
        ...(importedBy.get(importedPath) ?? []),
        analysis.path
      ]);
    }
  }

  const modified = new Set(modifiedPaths.map(normalizeRelativePath));
  const normalizedFocusPath = focusPath
    ? normalizeRelativePath(focusPath)
    : undefined;
  const terms = queryTerms(query);
  const scored = analyses.map(analysis => {
    const pathText = analysis.path.toLocaleLowerCase();
    const symbolText = analysis.symbols.join('\n').toLocaleLowerCase();
    const importText = analysis.rawImports.join('\n').toLocaleLowerCase();
    let score = modified.has(analysis.path) ? 80 : 0;
    if (analysis.path === normalizedFocusPath) {
      score += 1_000;
    }
    for (const term of terms) {
      if (pathText.includes(term)) {
        score += 40;
      }
      if (symbolText.includes(term)) {
        score += 60;
      }
      if (importText.includes(term)) {
        score += 15;
      }
    }
    return { analysis, score };
  });

  const seedPaths = new Set(
    scored
      .filter(entry => entry.score > 0)
      .map(entry => entry.analysis.path)
  );
  for (const entry of scored) {
    const neighbors = [
      ...(importsByPath.get(entry.analysis.path) ?? []),
      ...(importedBy.get(entry.analysis.path) ?? [])
    ];
    if (neighbors.some(path => seedPaths.has(path))) {
      entry.score += 20;
    }
  }

  return scored
    .sort((left, right) =>
      right.score - left.score ||
      left.analysis.path.localeCompare(right.analysis.path)
    )
    .slice(0, maxFiles)
    .map(({ analysis, score }) => ({
      path: analysis.path,
      imports: importsByPath.get(analysis.path) ?? [],
      importedBy: importedBy.get(analysis.path) ?? [],
      symbols: analysis.symbols,
      score,
      modified: modified.has(analysis.path)
    }));
}

async function createRepoMap(
  request: RepoMapWorkerRequest
): Promise<RepoMapWorkerResult> {
  const analyses: FileAnalysis[] = [];
  let cacheHits = 0;
  let parseErrors = 0;
  for (const file of request.files) {
    try {
      const result = await analyzeFile(request.workspaceRoot, file);
      if (result.analysis) {
        analyses.push(result.analysis);
      } else {
        parseErrors += 1;
      }
      if (result.cacheHit) {
        cacheHits += 1;
      }
    } catch {
      parseErrors += 1;
    }
  }
  return {
    files: rankRepoMap(
      analyses,
      request.query,
      request.focusPath,
      request.modifiedPaths,
      request.maxFiles
    ),
    candidateCount: request.files.length,
    cacheHits,
    parseErrors
  };
}

function diagnosticCategory(
  category: ts.DiagnosticCategory
): DiagnosticEntry['category'] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return 'error';
    case ts.DiagnosticCategory.Warning:
      return 'warning';
    case ts.DiagnosticCategory.Suggestion:
      return 'suggestion';
    default:
      return 'message';
  }
}

function toDiagnosticEntry(
  diagnostic: ts.Diagnostic,
  workspaceRoot: string,
  allowedSourceFiles: ReadonlySet<string>,
  reportSourceFiles: ReadonlySet<string>
): DiagnosticEntry | undefined {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file) {
    return {
      code: diagnostic.code,
      category: diagnosticCategory(diagnostic.category),
      message
    };
  }
  const absolutePath = resolve(diagnostic.file.fileName);
  if (!isInside(resolve(workspaceRoot), absolutePath)) {
    return undefined;
  }
  if (
    SOURCE_EXTENSIONS.has(extname(absolutePath).toLowerCase()) &&
    (
      !allowedSourceFiles.has(pathKey(absolutePath)) ||
      (
        reportSourceFiles.size > 0 &&
        !reportSourceFiles.has(pathKey(absolutePath))
      )
    )
  ) {
    return undefined;
  }
  const position = diagnostic.start === undefined
    ? undefined
    : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    code: diagnostic.code,
    category: diagnosticCategory(diagnostic.category),
    message,
    path: normalizeRelativePath(relative(workspaceRoot, absolutePath)),
    ...(position
      ? { line: position.line + 1, column: position.character + 1 }
      : {})
  };
}

function createDiagnostics(
  request: DiagnosticsWorkerRequest
): DiagnosticsWorkerResult {
  const workspaceRoot = resolve(request.workspaceRoot);
  const allowedFiles = request.files.map(file => resolve(workspaceRoot, file));
  const allowedSourceFiles = new Set(
    allowedFiles.map(pathKey)
  );
  const reportSourceFiles = new Set(
    (request.reportFiles ?? []).map(file =>
      pathKey(resolve(workspaceRoot, file))
    )
  );
  let rootNames = [...allowedFiles];
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10
  };
  const configurationDiagnostics: ts.Diagnostic[] = [];

  if (request.configPath) {
    const configPath = safeAbsolutePath(workspaceRoot, request.configPath);
    const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
    if (readResult.error) {
      configurationDiagnostics.push(readResult.error);
    } else {
      const parsed = ts.parseJsonConfigFileContent(
        readResult.config,
        ts.sys,
        dirname(configPath),
        {
          noEmit: true,
          incremental: false,
          composite: false,
          tsBuildInfoFile: undefined
        },
        configPath
      );
      configurationDiagnostics.push(...parsed.errors);
      rootNames = parsed.fileNames
        .map(file => resolve(file))
        .filter(file =>
          isInside(workspaceRoot, file) &&
          SOURCE_EXTENSIONS.has(extname(file).toLowerCase()) &&
          (
            allowedSourceFiles.size === 0 ||
            allowedSourceFiles.has(pathKey(file))
          )
        );
      options = {
        ...parsed.options,
        noEmit: true,
        incremental: false,
        composite: false,
        tsBuildInfoFile: undefined
      };
    }
  }

  const compilerHost = ts.createCompilerHost(options);
  const isAllowedCompilerPath = (fileName: string): boolean => {
    const absolutePath = resolve(fileName);
    if (!isInside(workspaceRoot, absolutePath)) {
      return true;
    }
    const normalized = normalizeRelativePath(relative(workspaceRoot, absolutePath));
    if (normalized.split('/').includes('node_modules')) {
      return true;
    }
    return !SOURCE_EXTENSIONS.has(extname(absolutePath).toLowerCase()) ||
      allowedSourceFiles.has(pathKey(absolutePath));
  };
  const originalFileExists = compilerHost.fileExists.bind(compilerHost);
  compilerHost.fileExists = fileName =>
    isAllowedCompilerPath(fileName) && originalFileExists(fileName);
  const originalReadFile = compilerHost.readFile.bind(compilerHost);
  compilerHost.readFile = fileName =>
    isAllowedCompilerPath(fileName) ? originalReadFile(fileName) : undefined;
  const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile
  ) => isAllowedCompilerPath(fileName)
    ? originalGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile
    )
    : undefined;

  const program = ts.createProgram({ rootNames, options, host: compilerHost });
  const diagnostics = [
    ...configurationDiagnostics,
    ...ts.getPreEmitDiagnostics(program)
  ];
  const visible = diagnostics
    .map(diagnostic =>
      toDiagnosticEntry(
        diagnostic,
        workspaceRoot,
        allowedSourceFiles,
        reportSourceFiles
      )
    )
    .filter((entry): entry is DiagnosticEntry => Boolean(entry));
  return {
    diagnostics: visible.slice(0, request.limit),
    total: visible.length,
    truncated: visible.length > request.limit,
    ...(request.configPath ? { configPath: request.configPath } : {}),
    fileCount: rootNames.length
  };
}

async function executeRequest(
  request: AnalysisWorkerRequest
): Promise<AnalysisWorkerResult> {
  return request.operation === 'repo-map'
    ? createRepoMap(request)
    : createDiagnostics(request);
}

parentPort?.on('message', async (message: WorkerRequestEnvelope) => {
  try {
    const result = await executeRequest(message.request);
    parentPort?.postMessage({
      id: message.id,
      ok: true,
      result
    });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'AnalysisWorkerError',
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
});
