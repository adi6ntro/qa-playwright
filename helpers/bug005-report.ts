import { promises as fs } from 'fs';
import path from 'path';
import type { BugResultCode, ScenarioRecord } from './bug005-probe';

/** Matches the runbook's own "Result codes per scenario" + "Report format" sections. */
export class Bug005Recorder {
  private results: ScenarioRecord[] = [];
  private anomalies: string[] = [];
  private cleanupChecklist: Record<string, boolean> = {};

  record(r: ScenarioRecord) {
    this.results.push(r);
  }

  all(): ScenarioRecord[] {
    return this.results;
  }

  noteAnomaly(text: string) {
    this.anomalies.push(text);
  }

  setCleanup(item: string, done: boolean) {
    this.cleanupChecklist[item] = done;
  }

  private tally() {
    const total = this.results.length;
    const counts: Record<BugResultCode, number> = {
      CLEAN: 0,
      FALSE_SUCCESS_LAG: 0,
      FALSE_SUCCESS_TRUE_FAIL: 0,
      RETRY_DUPLICATE: 0,
      RETRY_SINGLE: 0,
      UNABLE_TO_TEST: 0,
    };
    for (const r of this.results) counts[r.resultCode] += 1;
    const falseSuccessTotal =
      counts.FALSE_SUCCESS_LAG + counts.FALSE_SUCCESS_TRUE_FAIL + counts.RETRY_DUPLICATE + counts.RETRY_SINGLE;
    return { total, counts, falseSuccessTotal };
  }

  /** Diagnosis verdict per the runbook's option (a) vs (b) framing. */
  private verdict(): string {
    const { counts } = this.tally();
    const pointsToA = counts.RETRY_DUPLICATE;
    const pointsToB = counts.RETRY_SINGLE + counts.FALSE_SUCCESS_TRUE_FAIL;
    if (pointsToA === 0 && pointsToB === 0) {
      return 'INCONCLUSIVE — no false-successes reproduced in this run.';
    }
    if (pointsToA > 0 && pointsToB === 0) {
      return 'Option (a) — replica lag / cache lag. Every observed false-success either converged on its own or produced a duplicate row on retry.';
    }
    if (pointsToB > 0 && pointsToA === 0) {
      return 'Option (b) — intermittent silent write failure. Retries did not produce duplicate rows; the first write never actually committed.';
    }
    return `MIXED — ${pointsToA} scenario(s) point to (a) replica lag, ${pointsToB} point to (b) silent failure. Both mechanisms may be in play; investigate per-scenario.`;
  }

  async writeTo(outDir: string): Promise<{ jsonPath: string; mdPath: string }> {
    await fs.mkdir(outDir, { recursive: true });
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // for display inside the report
    // Filename uses a full timestamp (not just the date) so re-running on the
    // same day produces a new file instead of silently overwriting the
    // previous run's report.
    const fileStamp = now.toISOString().replace(/[:.]/g, '-'); // e.g. 2026-08-05T12-34-56-789Z
    const jsonPath = path.join(outDir, `QA_Report_BUG005_${fileStamp}.json`);
    const mdPath = path.join(outDir, `QA_Report_BUG005_${fileStamp}.md`);

    await fs.writeFile(
      jsonPath,
      JSON.stringify(
        { results: this.results, anomalies: this.anomalies, cleanupChecklist: this.cleanupChecklist },
        null,
        2
      ),
      'utf-8'
    );
    await fs.writeFile(mdPath, this.toMarkdown(dateStr), 'utf-8');
    return { jsonPath, mdPath };
  }

  private toMarkdown(dateStr: string): string {
    const { total, counts, falseSuccessTotal } = this.tally();
    const pct = (n: number) => (total ? `${((n / total) * 100).toFixed(0)}%` : '0%');

    const rows = this.results
      .map(
        (r) =>
          `| ${r.id} | ${r.tool} | ${r.resultCode} | ${r.retryNeeded ? 'Y' : 'N'} | ${r.duplicateOnRetry} | ${
            r.convergenceDelayMs !== undefined ? `${r.convergenceDelayMs}ms` : '-'
          } |`
      )
      .join('\n');

    const evidence = this.results
      .map(
        (r) =>
          `### ${r.id} — ${r.tool}\n\n**Trigger:** ${r.trigger}\n\n**Result:** ${r.resultCode}\n\n**Evidence:** ${r.evidence}\n`
      )
      .join('\n');

    const cleanupLines =
      Object.entries(this.cleanupChecklist)
        .map(([k, v]) => `- [${v ? 'x' : ' '}] ${k}`)
        .join('\n') || '(not recorded)';

    const anomalyLines = this.anomalies.length ? this.anomalies.map((a) => `- ${a}`).join('\n') : '(none noted)';

    return `# QA Report — BUG-005 False-Success on Writes (${dateStr})

Environment: ${process.env.BASE_URL || 'https://dev.reporty.sa'}

## 1. Diagnosis verdict

${this.verdict()}

## 2. Aggregate tally

- Total writes attempted: ${total}
- CLEAN: ${counts.CLEAN} / ${pct(counts.CLEAN)}
- FALSE_SUCCESS (any kind): ${falseSuccessTotal} / ${pct(falseSuccessTotal)}
  - RETRY_DUPLICATE (→ option a): ${counts.RETRY_DUPLICATE}
  - RETRY_SINGLE (→ option b): ${counts.RETRY_SINGLE}
  - FALSE_SUCCESS_LAG (converged without a scored retry): ${counts.FALSE_SUCCESS_LAG}
  - FALSE_SUCCESS_TRUE_FAIL (never converged): ${counts.FALSE_SUCCESS_TRUE_FAIL}
- UNABLE_TO_TEST: ${counts.UNABLE_TO_TEST}

## 3. Per-scenario table

| Scenario | Tool | Result | Retry needed | Duplicate on retry | Convergence delay |
| --- | --- | --- | --- | --- | --- |
${rows}

## 4. Verbatim evidence

${evidence}

## 5. Cleanup verification

${cleanupLines}

## 6. Anomalies

${anomalyLines}
`;
  }
}