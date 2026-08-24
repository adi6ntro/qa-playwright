import { promises as fs } from 'fs';
import path from 'path';

/**
 * Deliberately conservative result codes. A script can reliably tell you
 * "the count didn't change", "the refresh lost the value", "an error banner
 * appeared" — it CANNOT reliably tell you "is this Arabic text verbatim
 * correct" or "does this read as a fabricated success". Those still need a
 * human (or an LLM) to look at the captured evidence. So:
 *
 *   PASS            - only auto-assigned for narrow, unambiguous mechanical checks
 *                      (e.g. persistence check succeeded, count moved by exactly 1)
 *   FAIL            - only auto-assigned for unambiguous mechanical failures
 *                      (e.g. persistence check failed, error banner detected,
 *                      network response was non-2xx)
 *   NEEDS_REVIEW    - default for anything requiring semantic judgement; evidence
 *                      is captured so a human/LLM pass can classify it
 *   UNABLE_TO_TEST  - matches the runbook's own code, for tools that can't be
 *                      exercised from this page/flow at all
 */
export type ResultCode = 'PASS' | 'FAIL' | 'NEEDS_REVIEW' | 'UNABLE_TO_TEST';

export interface ToolResult {
  id: string;
  tool: string;
  trigger: string;
  result: ResultCode;
  evidence: string;
  confirmRoundsNeeded?: number;
  persisted?: boolean | 'not_checked';
}

export class ReportRecorder {
  private results: ToolResult[] = [];

  constructor(private sectionName: string) {}

  record(r: ToolResult) {
    this.results.push(r);
  }

  async writeTo(outDir: string) {
    await fs.mkdir(outDir, { recursive: true });
    const base = this.sectionName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const jsonPath = path.join(outDir, `${base}.json`);
    const mdPath = path.join(outDir, `${base}.md`);

    await fs.writeFile(jsonPath, JSON.stringify(this.results, null, 2), 'utf-8');
    await fs.writeFile(mdPath, this.toMarkdown(), 'utf-8');
  }

  private toMarkdown(): string {
    const total = this.results.length;
    const counts: Record<ResultCode, number> = {
      PASS: 0,
      FAIL: 0,
      NEEDS_REVIEW: 0,
      UNABLE_TO_TEST: 0,
    };
    for (const r of this.results) counts[r.result] += 1;

    const rows = this.results
      .map(
        (r) =>
          `| ${r.id} | ${r.tool} | ${r.result} | ${escapeCell(r.evidence)}${
            r.confirmRoundsNeeded ? ` (confirm rounds: ${r.confirmRoundsNeeded})` : ''
          }${r.persisted !== undefined ? ` (persisted: ${r.persisted})` : ''} |`
      )
      .join('\n');

    return `# ${this.sectionName} — automated run

**Total tools tested:** ${total}
**PASS:** ${counts.PASS}  **FAIL:** ${counts.FAIL}  **NEEDS_REVIEW:** ${counts.NEEDS_REVIEW}  **UNABLE_TO_TEST:** ${counts.UNABLE_TO_TEST}

> NEEDS_REVIEW rows have real evidence captured (chat reply text, panel
> state) but require a human or LLM read-through to judge correctness —
> this script does not fabricate semantic PASS/FAIL judgements.

## Results

| ID | Tool | Result | Evidence |
| --- | --- | --- | --- |
${rows}
`;
  }
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 400);
}
