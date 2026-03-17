/**
 * Wirlwind Telemetry — Output Scrubber
 *
 * Strips command echo (top) and device prompt (bottom) from raw CLI output
 * before it reaches the parser chain. This is a central fix — individual
 * TextFSM templates should not need to handle echoed commands or prompts.
 *
 * Usage in pollEngine.runCycle():
 *   const raw = await this.executeCommand(def.command);
 *   const cleaned = scrubOutput(raw, def.command, this.detectedPrompt);
 *   const result = parseOutput(cleaned, def, collectionName);
 */

/**
 * Remove command echo from the top and prompt from the bottom of raw CLI output.
 *
 * @param raw - Raw output from SSH executeCommand (may include \r\n)
 * @param command - The CLI command that was sent (e.g., "show interfaces description")
 * @param prompt - The detected device prompt (e.g., "agg1.iad1>" or "agg1.iad1#")
 * @returns Cleaned output with only the command response
 */
export function scrubOutput(raw: string, command: string, prompt?: string): string {
  if (!raw) return raw;

  // Normalize line endings
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let lines = text.split('\n');

  // ── Strip command echo from top ──────────────────────────
  // The first line(s) may contain the echoed command, possibly with
  // leading whitespace or prompt prefix. Find and remove everything
  // up to and including the line that contains the command string.
  const cmdNormalized = command.trim().toLowerCase();
  let echoIndex = -1;

  // Search within the first few lines (echo is always near the top)
  const searchLimit = Math.min(lines.length, 5);
  for (let i = 0; i < searchLimit; i++) {
    const lineNorm = lines[i].trim().toLowerCase();
    if (lineNorm.includes(cmdNormalized) || cmdNormalized.includes(lineNorm)) {
      echoIndex = i;
      break;
    }
  }

  if (echoIndex >= 0) {
    lines = lines.slice(echoIndex + 1);
  }

  // ── Strip prompt from bottom ─────────────────────────────
  // Walk backwards from the end removing:
  //   - Empty/whitespace lines
  //   - Lines that look like the device prompt
  //   - Lines that are just the prompt with a trailing command or space
  if (prompt) {
    // Build a normalized prompt prefix for matching
    // Handle both "hostname>" and "hostname#" patterns
    const promptBase = prompt.trim().replace(/[>#$]\s*$/, '').toLowerCase();

    // Trim trailing empty lines first
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    // Check last line(s) for prompt
    const checkLimit = Math.min(lines.length, 3);
    for (let i = 0; i < checkLimit; i++) {
      const lastLine = lines[lines.length - 1]?.trim().toLowerCase() ?? '';
      if (!lastLine) {
        lines.pop();
        continue;
      }
      // Match if line starts with prompt base (e.g., "agg1.iad1>", "agg1.iad1#show...")
      if (lastLine.startsWith(promptBase)) {
        lines.pop();
      } else {
        break;
      }
    }
  } else {
    // No prompt provided — just trim trailing blanks
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
  }

  // ── Strip leading blank lines ────────────────────────────
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }

  return lines.join('\n');
}