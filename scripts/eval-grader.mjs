import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [taskId, workspaceArgument, typeScriptRuntimeArgument] = process.argv.slice(2);
if (!taskId || !workspaceArgument) {
  throw new Error('Use: node scripts/eval-grader.mjs <task-id> <workspace>');
}
const workspace = resolve(workspaceArgument);
const unknownStaticValue = Symbol('unknown-static-value');

function check(name, passed, code) {
  return {
    name,
    passed,
    ...(passed || !code ? {} : { code })
  };
}

async function importWorkspaceModule(path) {
  const url = pathToFileURL(join(workspace, path));
  url.searchParams.set('eval', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function unwrapExpression(ts, original) {
  let expression = original;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function evaluateStaticValue(ts, original) {
  const expression = unwrapExpression(ts, original);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.PlusToken ||
      expression.operator === ts.SyntaxKind.MinusToken)
  ) {
    const operand = evaluateStaticValue(ts, expression.operand);
    if (typeof operand !== 'number') {
      return unknownStaticValue;
    }
    return expression.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'String' &&
    expression.arguments.length === 1
  ) {
    const argument = evaluateStaticValue(ts, expression.arguments[0]);
    return argument === unknownStaticValue ? unknownStaticValue : String(argument);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateStaticValue(ts, expression.left);
    const right = evaluateStaticValue(ts, expression.right);
    if (left === unknownStaticValue || right === unknownStaticValue) {
      return unknownStaticValue;
    }
    if (
      (typeof left === 'string' || typeof left === 'number') &&
      (typeof right === 'string' || typeof right === 'number')
    ) {
      return left + right;
    }
  }
  return unknownStaticValue;
}

function isStringType(ts, type) {
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) {
    return true;
  }
  return type.isUnion() && type.types.every((entry) => isStringType(ts, entry));
}

async function labelContractPasses() {
  if (!typeScriptRuntimeArgument) {
    return false;
  }
  try {
    const imported = await import(pathToFileURL(resolve(typeScriptRuntimeArgument)).href);
    const ts = imported.default ?? imported;
    const sourcePath = join(workspace, 'src', 'label.ts');
    const program = ts.createProgram([sourcePath], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022
    });
    const sourceFile = program.getSourceFile(sourcePath);
    if (!sourceFile) {
      return false;
    }

    const declarations = [];
    for (const statement of sourceFile.statements) {
      const exported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      );
      if (
        !exported ||
        !ts.isVariableStatement(statement) ||
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === 'label') {
          declarations.push(declaration);
        }
      }
    }
    if (declarations.length !== 1 || !declarations[0].initializer) {
      return false;
    }

    const declaration = declarations[0];
    const type = program.getTypeChecker().getTypeAtLocation(declaration.name);
    return isStringType(ts, type) && evaluateStaticValue(ts, declaration.initializer) === '42';
  } catch {
    return false;
  }
}

async function grade() {
  const checks = [];
  if (taskId === 'cross-file-bug') {
    try {
      const [{ calculateTax }, { checkoutTotal }] = await Promise.all([
        importWorkspaceModule('src/tax.mjs'),
        importWorkspaceModule('src/checkout.mjs')
      ]);
      checks.push(
        check('external-tax-behavior', calculateTax(100, 0.1) === 10, 'TAX_BEHAVIOR'),
        check('external-checkout-behavior', checkoutTotal(100, 0.1) === 110, 'CHECKOUT_BEHAVIOR')
      );
    } catch {
      checks.push(check('external-cross-file-import', false, 'IMPORT'));
    }
  } else if (taskId === 'feature') {
    try {
      const { clamp } = await importWorkspaceModule('src/clamp.mjs');
      checks.push(
        check(
          'external-clamp-behavior',
          typeof clamp === 'function' &&
            clamp(-1, 0, 10) === 0 &&
            clamp(5, 0, 10) === 5 &&
            clamp(12, 0, 10) === 10,
          'CLAMP_BEHAVIOR'
        )
      );
    } catch {
      checks.push(check('external-feature-import', false, 'IMPORT'));
    }
  } else if (taskId === 'type-error') {
    checks.push(check('external-label-contract', await labelContractPasses(), 'LABEL_CONTRACT'));
  } else if (taskId === 'recovery') {
    try {
      const { add } = await importWorkspaceModule('src/calculator.mjs');
      checks.push(
        check(
          'external-recovery-behavior',
          typeof add === 'function' && add(2, 3) === 5 && add(-2, 2) === 0,
          'ADD_BEHAVIOR'
        )
      );
    } catch {
      checks.push(check('external-recovery-import', false, 'IMPORT'));
    }
  }
  return checks;
}

console.log(JSON.stringify({ checks: await grade() }));
