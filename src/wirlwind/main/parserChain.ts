/**
 * Wirlwind Telemetry — Parser Chain
 * Ported from Python parser_chain.py
 *
 * Tries parsers in order: textfsm → regex → raw passthrough.
 * Each collection definition specifies which parser(s) to use.
 *
 * TextFSM: Uses tfsmjs (github:scottpeterman/tfsmjs)
 * Regex:   Named capture groups from YAML-defined patterns
 * TTP:     Placeholder — not yet ported (Python-only for now)
 */

import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import type { CollectionDef, ParsedResult, RegexPattern } from '../shared/types';
import { getWorkspacePath } from './workspace';

// tfsmjs import — module exports { TextFSM, TextFSMValue, ... }
let TextFSM: any;
try {
  const tfsmModule = require('../../tfsmjs/tfsm-node');
  TextFSM = tfsmModule.TextFSM;
} catch {
  log.warn('tfsmjs not found — TextFSM parsing disabled');
}

let templatesBasePath: string;

/**
 * Initialize the parser chain with template paths.
 */
export function initParser(basePath?: string): void {
  if (basePath) {
    templatesBasePath = basePath;
  } else {
    const resourcePath = path.join(process.resourcesPath || '', 'templates');
    // In dev, __dirname is dist/wirlwind/main/ — go up 3 levels to project root
    const devPath = path.join(__dirname, '..', '..', '..', 'templates');
    const cwdPath = path.join(process.cwd(), 'templates');

    if (fs.existsSync(resourcePath)) {
      templatesBasePath = resourcePath;
    } else if (fs.existsSync(devPath)) {
      templatesBasePath = devPath;
    } else {
      templatesBasePath = cwdPath;
    }
  }

  log.info(`Templates path: ${templatesBasePath}`);
}

/**
 * Parse command output using the collection definition's parser config.
 *
 * Tries parsers in the order specified by the collection def.
 * Falls back to raw output if all parsers fail.
 *
 * @param rawOutput - Raw command output (ANSI-filtered)
 * @param collectionDef - Collection definition with parser config
 * @param collectionName - Name for logging
 * @returns Parsed result with metadata
 */
export function parseOutput(
  rawOutput: string,
  collectionDef: CollectionDef,
  collectionName: string
): ParsedResult {
  const startTime = Date.now();

  // Try the configured parser
  switch (collectionDef.parser) {
    case 'textfsm':
      if (collectionDef.textfsm_template) {
        const result = parseTextFSM(rawOutput, collectionDef.textfsm_template);
        if (result) {
          log.debug(`[${collectionName}] TextFSM parsed in ${Date.now() - startTime}ms`);
          return result;
        }
      }
      break;

    case 'regex':
      if (collectionDef.regex_patterns) {
        const result = parseRegex(rawOutput, collectionDef.regex_patterns);
        if (result) {
          log.debug(`[${collectionName}] Regex parsed in ${Date.now() - startTime}ms`);
          return result;
        }
      }
      break;

    case 'ttp':
      log.debug(`[${collectionName}] TTP not yet ported to JS — falling back`);
      break;

    case 'none':
      return {
        _parsed_by: 'none',
        _raw: rawOutput,
      };
  }

  // Fallback: try TextFSM if defined, then regex
  if (collectionDef.parser !== 'textfsm' && collectionDef.textfsm_template) {
    const result = parseTextFSM(rawOutput, collectionDef.textfsm_template);
    if (result) return result;
  }

  if (collectionDef.parser !== 'regex' && collectionDef.regex_patterns) {
    const result = parseRegex(rawOutput, collectionDef.regex_patterns);
    if (result) return result;
  }

  // Nothing worked
  log.warn(`[${collectionName}] All parsers failed`);
  return {
    _parsed_by: 'none',
    _error: 'All parsers failed',
    _raw: rawOutput,
  };
}

// ─── TextFSM Parser ──────────────────────────────────────────

function parseTextFSM(rawOutput: string, templateName: string): ParsedResult | null {
  if (!TextFSM) return null;

  // Resolve template path
  const templatePath = resolveTemplatePath(templateName);
  if (!templatePath) {
    log.warn(`TextFSM template not found: ${templateName}`);
    return null;
  }

  try {
    const templateContent = fs.readFileSync(templatePath, 'utf-8');
    const fsm = new TextFSM(templateContent);
    const results = fsm.parseTextToDicts(rawOutput);

    if (!results || results.length === 0) {
      log.debug(`TextFSM returned empty results for ${templateName}`);
      return null;
    }

    // parseTextToDicts returns [{ HEADER: value, ... }, ...]
    return {
      _parsed_by: 'textfsm',
      _template: templateName,
      entries: results,
    };
  } catch (err) {
    log.debug(`TextFSM parse error (${templateName}): ${err}`);
    return null;
  }
}

/**
 * Resolve a template name to a file path.
 * Searches: templates/textfsm/<name>, templates/<name>
 */
function resolveTemplatePath(name: string): string | null {
  const ws = getWorkspacePath();
  const searchBases = ws
    ? [path.join(ws, 'templates'), templatesBasePath]
    : [templatesBasePath];

  for (const base of searchBases) {
    const candidates = [
      path.join(base, 'textfsm', name),
      path.join(base, name),
    ];

    if (!name.endsWith('.textfsm')) {
      candidates.push(
        path.join(base, 'textfsm', name + '.textfsm'),
        path.join(base, name + '.textfsm')
      );
    }

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        if (ws && base !== templatesBasePath) {
          log.info(`[workspace] template: ${name}`);
        }
        return p;
      }
    }
  }

  return null;
}

// ─── Regex Parser ────────────────────────────────────────────

function parseRegex(
  rawOutput: string,
  patterns: RegexPattern[]
): ParsedResult | null {
  const result: Record<string, any> = {};
  let matchCount = 0;

  for (const pat of patterns) {
    try {
      const regex = new RegExp(pat.pattern, 'm');
      const match = rawOutput.match(regex);

      if (match) {
        const group = pat.group ?? 1;
        let value: any = match[group] ?? match[0];

        // Type coercion
        if (pat.type === 'int') value = parseInt(value, 10);
        else if (pat.type === 'float') value = parseFloat(value);
        else value = String(value).trim();

        result[pat.name] = value;
        matchCount++;
      }
    } catch (err) {
      log.debug(`Regex error for ${pat.name}: ${err}`);
    }
  }

  if (matchCount === 0) return null;

  return {
    _parsed_by: 'regex',
    ...result,
  };
}

// ─── Parse Trace (debug) ────────────────────────────────────

export interface ParseTrace {
  collection: string;
  parser: string;
  template?: string;
  success: boolean;
  elapsed: number;
  error?: string;
  resultKeys?: string[];
}

/**
 * Run parse with tracing — returns both result and debug trace.
 * Used for the debug modal's parser tag display.
 */
export function parseWithTrace(
  rawOutput: string,
  collectionDef: CollectionDef,
  collectionName: string
): { result: ParsedResult; trace: ParseTrace } {
  const start = Date.now();
  const result = parseOutput(rawOutput, collectionDef, collectionName);
  const elapsed = Date.now() - start;

  const trace: ParseTrace = {
    collection: collectionName,
    parser: result._parsed_by,
    template: result._template,
    success: result._parsed_by !== 'none',
    elapsed,
    error: result._error,
    resultKeys: Object.keys(result).filter((k) => !k.startsWith('_')),
  };

  return { result, trace };
}