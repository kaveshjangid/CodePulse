import path from 'node:path';
import crypto from 'node:crypto';

const SUPPORTED_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.html', '.css', '.json', '.vue', '.svelte', '.py', '.java', '.go', '.php'
]);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
  'vendor', '__MACOSX', '.venv', 'venv', 'target'
]);

const severityRank = (severity) => ({ high: 3, medium: 2, low: 1 }[severity] || 0);

function suggestedFix(rule) {
  const fixes = {
    'debug/no-debugger': 'Remove the debugger statement before shipping, unless it is intentionally part of a local debugging workflow.',
    'debug/no-console-log': 'Remove the console.log call or replace it with your application logger.',
    'security/hard-coded-secret': 'Move the value into an environment variable, rotate the exposed credential, and ensure secrets are not committed.',
    'security/unsafe-html': 'Avoid inserting untrusted HTML. Prefer textContent or a framework-safe rendering method; sanitize HTML if it must be rendered.',
    'maintainability/todo': 'Resolve the TODO/FIXME or link it to a tracked issue with an owner.',
    'style/max-line-length': 'Wrap the expression or extract a helper to make the line easier to review.',
    'maintainability/file-size': 'Split the file into smaller modules with clear responsibilities.',
    'eslint/no-unused-vars': 'Remove the unused variable or use it if it was unintentionally left behind.'
  };
  return fixes[rule] || 'Review this location and confirm whether the pattern is intentional. Refactor only after checking the surrounding code.';
}

function createFinding(sourceByFile, findings, finding) {
  const lines = sourceByFile.get(finding.file)?.split(/\r?\n/) || [];
  const lineNumber = Math.max(1, Number(finding.line) || 1);
  const snippet = (lines[lineNumber - 1] || '').trim().slice(0, 240);
  findings.push({
    id: crypto.randomUUID(),
    severity: 'low',
    ...finding,
    line: lineNumber,
    snippet,
    suggestedFix: finding.suggestedFix || suggestedFix(finding.rule)
  });
}

async function runEslint(sourceByFile, findings) {
  let ESLint;
  try {
    ({ ESLint } = await import('eslint'));
  } catch {
    return { available: false, message: 'ESLint is not installed; built-in checks were used.' };
  }

  let eslint;
  try {
    eslint = new ESLint({
      useEslintrc: false,
      ignore: true,
      baseConfig: {
        env: { browser: true, node: true, es2022: true },
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
        extends: ['eslint:recommended'],
        rules: {
          'no-debugger': 'error',
          'no-console': 'warn',
          'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
        }
      }
    });
  } catch (error) {
    return { available: false, message: `ESLint configuration could not start: ${error.message}` };
  }

  let checked = 0;
  for (const [file, source] of sourceByFile.entries()) {
    if (!/\.(?:js|jsx|mjs|cjs)$/.test(file)) continue;
    try {
      const results = await eslint.lintText(source, { filePath: path.resolve('/codepulse', file) });
      for (const result of results) {
        checked += 1;
        for (const message of result.messages) {
          const rule = message.ruleId ? `eslint/${message.ruleId}` : 'eslint/parse-error';
          const line = message.line || 1;
          const sourceLines = source.split(/\r?\n/);
          findings.push({
            id: crypto.randomUUID(),
            severity: message.severity === 2 ? 'high' : 'medium',
            category: message.fatal ? 'Syntax' : 'ESLint',
            file,
            line,
            title: message.message,
            detail: `ESLint ${message.ruleId || 'parser'}: ${message.message}`,
            rule,
            snippet: (sourceLines[line - 1] || '').trim().slice(0, 240),
            suggestedFix: message.fix
              ? 'ESLint reports an automatic fix is available. Review the change before applying it.'
              : suggestedFix(rule)
          });
        }
      }
    } catch {
      // Some source files (for example TypeScript) need a dedicated parser.
      // Skip parser-incompatible files instead of failing the whole repository scan.
    }
  }
  return { available: true, filesChecked: checked, message: 'ESLint rules ran on supported JavaScript files.' };
}

export async function scanSourceFiles(sourceFiles, originalName = 'uploaded-project') {
  if (!sourceFiles.length) {
    const error = new Error('No supported source files were found. Include JavaScript, TypeScript, HTML, CSS, JSON, or another supported file type.');
    error.status = 400;
    throw error;
  }
  if (sourceFiles.length > MAX_FILES) {
    const error = new Error(`Project contains too many files. Limit: ${MAX_FILES}.`);
    error.status = 413;
    throw error;
  }

  const projectName = path.basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9._ -]/g, '').trim().slice(0, 64) || 'uploaded-project';
  const findings = [];
  const sourceByFile = new Map();
  const languageCounts = new Map();
  const repeatedLineCounts = new Map();
  let filesScanned = 0;
  let linesOfCode = 0;
  let totalBytes = 0;
  let duplicatedLines = 0;

  for (const sourceFile of sourceFiles) {
    const file = String(sourceFile.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!file || file.split('/').some((part) => part === '..' || IGNORED_DIRECTORIES.has(part))) continue;
    const extension = path.extname(file).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) continue;

    const buffer = Buffer.isBuffer(sourceFile.content)
      ? sourceFile.content
      : Buffer.from(String(sourceFile.content ?? ''), 'utf8');
    if (buffer.length > MAX_FILE_BYTES) {
      createFinding(sourceByFile, findings, {
        severity: 'medium', category: 'Repository', file, line: 1,
        title: 'Source file skipped: size limit exceeded',
        detail: 'This file exceeds the 1 MB scanner limit and was not analyzed.',
        rule: 'scanner/file-size-limit', snippet: ''
      });
      continue;
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      const error = new Error('Total source size exceeds the 12 MB analysis limit. Try a smaller project.');
      error.status = 413;
      throw error;
    }
    const source = buffer.toString('utf8');
    if (source.includes('\0')) continue;
    sourceByFile.set(file, source);
    filesScanned += 1;
    const language = ({ '.ts': 'TypeScript', '.tsx': 'TypeScript', '.html': 'HTML', '.css': 'CSS', '.json': 'JSON', '.py': 'Python', '.java': 'Java', '.go': 'Go', '.php': 'PHP', '.vue': 'Vue', '.svelte': 'Svelte' })[extension] || 'JavaScript';
    languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
    const lines = source.split(/\r?\n/);
    linesOfCode += lines.filter((line) => line.trim() && !line.trim().startsWith('//')).length;

    if (buffer.length > 45 * 1024) {
      createFinding(sourceByFile, findings, {
        severity: 'medium', category: 'Maintainability', file, line: 1,
        title: 'Large source file', detail: `This file is ${(buffer.length / 1024).toFixed(1)} KB. Consider splitting unrelated responsibilities into smaller modules.`,
        rule: 'maintainability/file-size'
      });
    }

    let branches = 0;
    const localFrequency = new Map();
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      const lineNumber = index + 1;
      if (line.length > 120) createFinding(sourceByFile, findings, {
        category: 'Readability', file, line: lineNumber,
        title: 'Long line is difficult to scan', detail: `This line contains ${line.length} characters. Wrapping expressions or extracting a helper may improve readability.`,
        rule: 'style/max-line-length'
      });
      if (/\bdebugger\s*;?/.test(line)) createFinding(sourceByFile, findings, {
        severity: 'high', category: 'Debugging', file, line: lineNumber,
        title: 'Debugger statement found', detail: 'A debugger statement can pause execution when developer tools are open. Remove it before release if not intentional.',
        rule: 'debug/no-debugger'
      });
      if (/\bconsole\.log\s*\(/.test(line)) createFinding(sourceByFile, findings, {
        severity: 'medium', category: 'Debugging', file, line: lineNumber,
        title: 'Console output left in source', detail: 'Remove unneeded console output or replace it with a structured logger.',
        rule: 'debug/no-console-log'
      });
      if (/\b(TODO|FIXME|HACK)\b/i.test(line)) createFinding(sourceByFile, findings, {
        category: 'Follow-up', file, line: lineNumber,
        title: 'Follow-up marker still present', detail: 'Confirm the marker is still relevant and track unfinished work in an issue if needed.',
        rule: 'maintainability/todo'
      });
      if (/(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(line) && !/process\.env|import\.meta\.env/i.test(line)) {
        createFinding(sourceByFile, findings, {
          severity: 'high', category: 'Security', file, line: lineNumber,
          title: 'Possible hard-coded secret', detail: 'This assignment resembles a credential or secret. It may be a false positive; verify the value and rotate it if it is real.',
          rule: 'security/hard-coded-secret'
        });
      }
      if (/\binnerHTML\s*=/.test(line)) createFinding(sourceByFile, findings, {
        severity: 'medium', category: 'Security', file, line: lineNumber,
        title: 'HTML inserted through innerHTML', detail: 'If the assigned value contains untrusted input, this pattern can introduce cross-site scripting risk.',
        rule: 'security/unsafe-html'
      });
      if (/\b(if|else\s+if|case|catch|for|while)\b|&&|\|\|/.test(line)) branches += 1;
      if (trimmed.length >= 36 && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('import ')) {
        localFrequency.set(trimmed, (localFrequency.get(trimmed) || 0) + 1);
      }
    });

    for (const [line, count] of localFrequency) {
      if (count > 1) {
        duplicatedLines += count - 1;
        const lineNumber = Math.max(1, lines.findIndex((item) => item.trim() === line) + 1);
        createFinding(sourceByFile, findings, {
          category: 'Duplication', file, line: lineNumber,
          title: 'Repeated source line', detail: `A non-trivial line appears ${count} times in this file. Consider extracting shared logic if behavior should remain consistent.`,
          rule: 'duplication/repeated-line'
        });
      }
    }
    if (branches >= 28) createFinding(sourceByFile, findings, {
      severity: 'medium', category: 'Complexity', file, line: 1,
      title: 'High conditional density', detail: `This file contains ${branches} lines with conditional or branching operators. This heuristic can produce false positives.`,
      rule: 'complexity/branch-density'
    });
  }

  if (!filesScanned) {
    const error = new Error('No supported source files were found in the project.');
    error.status = 400;
    throw error;
  }

  const eslintStatus = await runEslint(sourceByFile, findings);
  const uniqueFindings = findings.filter((finding, index, all) => all.findIndex((item) => item.file === finding.file && item.line === finding.line && item.rule === finding.rule && item.title === finding.title) === index);
  uniqueFindings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const results = uniqueFindings.slice(0, 400);
  const high = results.filter((finding) => finding.severity === 'high').length;
  const medium = results.filter((finding) => finding.severity === 'medium').length;
  const low = results.filter((finding) => finding.severity === 'low').length;
  const languageTotal = [...languageCounts.values()].reduce((sum, count) => sum + count, 0) || 1;

  return {
    id: crypto.randomUUID(), projectName, createdAt: new Date().toISOString(),
    score: Math.max(0, Math.min(100, Math.round(100 - high * 8 - medium * 3 - low * 1.2))),
    summary: {
      filesScanned, linesOfCode, issues: results.length, high, medium, low, duplicatedLines,
      languages: Object.fromEntries([...languageCounts].map(([name, count]) => [name, Math.round(count / languageTotal * 100)])),
      analysis: { eslint: eslintStatus }
    },
    findings: results
  };
}

export async function scanArchive(zip, originalName = 'uploaded-project.zip') {
  const entries = zip.getEntries();
  if (!entries.length) {
    const error = new Error('The ZIP archive is empty or could not be read.');
    error.status = 400;
    throw error;
  }
  if (entries.length > MAX_FILES) {
    const error = new Error(`Archive contains too many entries. Limit: ${MAX_FILES}.`);
    error.status = 413;
    throw error;
  }
  const sourceFiles = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = String(entry.entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name.split('/').some((part) => part === '..' || IGNORED_DIRECTORIES.has(part))) continue;
    if (!SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const declaredSize = Number(entry.header?.size || 0);
    if (declaredSize > MAX_FILE_BYTES) continue;
    const content = entry.getData();
    if (!content || content.length > MAX_FILE_BYTES) continue;
    sourceFiles.push({ name, content });
  }
  return scanSourceFiles(sourceFiles, originalName);
}
