export type SimulationContext = Record<string, unknown>;

export interface SimulationResult {
  prompt: string;
  unresolvedReferences: string[];
  skippedConditions: string[];
  templateCount: number;
  executionChain: Array<{
    phase: 'before_reasoning' | 'after_reasoning';
    statement: string;
    status: 'evaluated' | 'action-skipped';
  }>;
}

function valueAtPath(expression: string, context: SimulationContext): unknown {
  const path = expression.trim().replace(/^@/, '').split('.').filter(Boolean);
  let current: unknown = context;

  for (const segment of path) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'None';
  if (value === undefined) return '';
  return JSON.stringify(value);
}

function parseLiteral(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'True') return true;
  if (trimmed === 'False') return false;
  if (trimmed === 'None') return null;
  const number = Number(trimmed);
  return Number.isNaN(number) ? trimmed : number;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Converts AgentScript `instructions` values into the pipe-prefixed format
 * consumed by the small renderer below. This covers the common system-level
 * form (`instructions: |`) as well as quoted, one-line instructions.
 */
function normalizeInstructionTemplates(source: string): string {
  const normalized: string[] = [];
  let templateIndent: number | null = null;

  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const content = line.trim();

    if (templateIndent !== null && content && indent <= templateIndent) {
      templateIndent = null;
    }

    const blockMatch = /^(\s*)instructions:\s*(?:\||->)\s*$/.exec(line);
    if (blockMatch) {
      templateIndent = blockMatch[1].length;
      normalized.push(line);
      continue;
    }

    const scalarMatch = /^(\s*)instructions:\s*(["'])(.*?)\2\s*$/.exec(line);
    if (scalarMatch) {
      normalized.push(`${scalarMatch[1]}| ${scalarMatch[3]}`);
      continue;
    }

    if (templateIndent !== null && content) {
      const existingPipe = /^\|\s?(.*)$/.exec(content);
      const templateContent = existingPipe ? existingPipe[1] : content;
      // Keep conditional control flow intact so the renderer can evaluate it.
      if (/^(if\s+.+:|else:)$/.test(templateContent)) {
        normalized.push(
          `${line.match(/^\s*/)?.[0] ?? ''}${templateContent}`
        );
      } else {
        normalized.push(
          `${line.match(/^\s*/)?.[0] ?? ''}| ${templateContent}`
        );
      }
      continue;
    }

    normalized.push(line);
  }

  return normalized.join('\n');
}

function evaluateCondition(
  expression: string,
  context: SimulationContext
): boolean | null {
  const notMatch = /^not\s+(@[\w.]+)$/.exec(expression.trim());
  if (notMatch) return !valueAtPath(notMatch[1], context);

  const comparison = /^(@[\w.]+)\s*(==|!=|is|is not)\s*(.+)$/.exec(
    expression.trim()
  );
  if (comparison) {
    const [, reference, operator, literal] = comparison;
    const equal = valuesEqual(
      valueAtPath(reference, context),
      parseLiteral(literal)
    );
    return operator === '!=' || operator === 'is not' ? !equal : equal;
  }

  const reference = /^(@[\w.]+)$/.exec(expression.trim());
  if (reference) return Boolean(valueAtPath(reference[1], context));

  return null;
}

function collectPhaseStatements(
  source: string,
  phase: 'before_reasoning' | 'after_reasoning',
  context: SimulationContext
): SimulationResult['executionChain'] {
  const steps: SimulationResult['executionChain'] = [];
  const conditions: Array<{ indent: number; include: boolean }> = [];
  let phaseIndent: number | null = null;

  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const content = line.trim();
    if (new RegExp(`^${phase}:\\s*(?:->)?$`).test(content)) {
      phaseIndent = indent;
      conditions.length = 0;
      continue;
    }
    if (phaseIndent === null) continue;
    if (content && indent <= phaseIndent) {
      phaseIndent = null;
      continue;
    }
    if (!content) continue;

    const isElse = content === 'else:';
    while (
      conditions.length &&
      indent < conditions.at(-1)!.indent + (isElse ? 0 : 1)
    ) {
      conditions.pop();
    }
    const parentIncluded = conditions.every(condition => condition.include);
    const ifMatch = /^if\s+(.+):$/.exec(content);
    if (ifMatch) {
      const evaluation = evaluateCondition(ifMatch[1], context);
      conditions.push({
        indent,
        include: parentIncluded && evaluation !== false,
      });
      continue;
    }
    if (isElse) {
      const previous = conditions.pop();
      if (previous) {
        conditions.push({
          indent,
          include: conditions.every(condition => condition.include) && !previous.include,
        });
      }
      continue;
    }
    if (!parentIncluded) continue;
    if (/^(with|set)\s+/.test(content) || /^transition\s+to\s+/.test(content)) {
      steps.push({ phase, statement: content, status: 'evaluated' });
    } else if (/^run\s+@actions\./.test(content)) {
      steps.push({ phase, statement: content, status: 'action-skipped' });
    }
  }
  return steps;
}

/**
 * Renders pipe-prefixed AgentScript templates using a simulator context.
 * This intentionally supports a safe, inspectable subset of conditions rather
 * than evaluating arbitrary AgentScript expressions in the browser.
 */
export function compileTemplates(
  source: string,
  context: SimulationContext
): SimulationResult {
  const output: string[] = [];
  const unresolvedReferences = new Set<string>();
  const skippedConditions: string[] = [];
  const conditionStack: Array<{
    indent: number;
    include: boolean;
    result: boolean;
  }> = [];
  let templateCount = 0;

  for (const line of normalizeInstructionTemplates(source).split('\n')) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const content = line.trim();
    const isElse = /^else:$/.test(content);

    while (
      conditionStack.length &&
      indent < conditionStack.at(-1)!.indent + (isElse ? 0 : 1)
    ) {
      conditionStack.pop();
    }

    const parentIncludes = conditionStack.every(scope => scope.include);
    const ifMatch = /^if\s+(.+):$/.exec(content);
    if (ifMatch) {
      const result = evaluateCondition(ifMatch[1], context);
      if (result === null) {
        skippedConditions.push(ifMatch[1]);
      }
      conditionStack.push({
        indent,
        include: parentIncludes && result !== false,
        result: result !== false,
      });
      continue;
    }

    if (isElse) {
      const previous = conditionStack.pop();
      if (previous) {
        conditionStack.push({
          indent,
          include:
            conditionStack.every(scope => scope.include) && !previous.result,
          result: !previous.result,
        });
      }
      continue;
    }

    const template = /^\s*\|\s?(.*)$/.exec(line);
    if (!template || !parentIncludes) continue;

    templateCount += 1;
    output.push(
      template[1].replace(
        /\{!\s*([^}]+?)\s*\}/g,
        (match, expression: string) => {
          const value = valueAtPath(expression, context);
          if (value === undefined) {
            unresolvedReferences.add(expression.trim());
            return match;
          }
          return formatValue(value);
        }
      )
    );
  }

  return {
    prompt: output.join('\n').trim(),
    unresolvedReferences: [...unresolvedReferences],
    skippedConditions,
    templateCount,
    executionChain: [
      ...collectPhaseStatements(source, 'before_reasoning', context),
      ...collectPhaseStatements(source, 'after_reasoning', context),
    ],
  };
}

export function parseSimulationContext(input: string): SimulationContext {
  const parsed: unknown = JSON.parse(input);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Context must be a JSON object.');
  }
  return parsed as SimulationContext;
}
