import { mkdir, writeFile } from 'node:fs/promises';

import stringWidth from 'fast-string-width';
import { wrapAnsi } from 'fast-wrap-ansi';

import doctorAgentSystem from '../cli/doctor.ts';
import installAgentSystem from '../cli/install.ts';
import { createCliStyles, renderCliSummary } from '../cli/output.ts';
import lifecyclePresentationLines from '../core/lifecycle-presentation.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { doctorFindings, installOutcomes } from '../test/lifecycle-presentation-fixtures.ts';

// Capture only injected results: no manifest discovery, inspection, or installation.
const workspaceDir = '/workspace/demo';
const styles = createCliStyles({ FORCE_COLOR: '3' });
const manifest: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { workspaceDir },
  path: `${workspaceDir}/agent.yaml`,
  digest: 'synthetic',
  manifest: { schemaVersion: 1, agent: { id: 'demo', name: 'Demo' } },
  diagnostics: [],
  validationChecks: [],
};
const cases = [
  {
    title: 'Doctor · all healthy',
    columns: 96,
    findings: doctorFindings.filter(({ status }) => status === 'healthy'),
  },
  {
    title: 'Doctor · actionable findings and long remediation',
    columns: 96,
    findings: doctorFindings,
  },
  { title: 'Install · unchanged and successful changes', columns: 96 },
  { title: 'Doctor · narrow terminal', columns: 40, findings: doctorFindings },
  { title: 'Install · narrow terminal', columns: 40 },
];

const captures = await Promise.all(
  cases.map(async ({ title, columns, findings }) => {
    const stdout: string[] = [];
    const shared = {
      json: false,
      manifestService: {
        async loadForAgentId() {
          return manifest;
        },
        async loadForCommandDirectory() {
          return manifest;
        },
      },
      output: {
        writeStdout(value: string) {
          stdout.push(value);
        },
        writeStderr(value: string) {
          throw new Error(value);
        },
      },
      setExitCode() {},
      styles,
      terminalColumns: columns,
      workspaceDir,
    };
    if (findings) {
      await doctorAgentSystem({
        ...shared,
        doctorService: {
          async inspect() {
            return {
              agentId: 'demo',
              findings,
              status: findings.some(({ status }) => status === 'blocked') ? 'blocked' : 'healthy',
              workspaceDir,
            };
          },
        },
      });
    } else {
      await installAgentSystem({
        ...shared,
        installService: {
          async install() {
            return { agentId: 'demo', outcomes: installOutcomes, warnings: [], workspaceDir };
          },
        },
      });
    }
    // The unchanged generic renderer reproduces the pre-change command presentation.
    const items = findings
      ? findings.map((finding) => ({
          ...finding,
          message: `${finding.message}${finding.remediation ? ` ${finding.remediation}` : ''}`,
        }))
      : installOutcomes;
    const before = renderCliSummary(
      [
        ...lifecyclePresentationLines(items),
        { label: 'workspace', style: 'target', value: workspaceDir },
      ],
      styles,
    ).join('\n');
    const terminalLines = (text: string) =>
      wrapAnsi(text.trimEnd(), columns, { hard: true, wordWrap: false, trim: false }).split('\n');
    return {
      title: `${title} · ${columns} columns`,
      before: terminalLines(before),
      after: terminalLines(stdout.join('')),
    };
  }),
);

const themes = {
  dark: {
    background: '#0d1117',
    foreground: '#e6edf3',
    colors: [
      '#0d1117',
      '#ff7b72',
      '#7ee787',
      '#e3b341',
      '#79c0ff',
      '#d2a8ff',
      '#76e3ea',
      '#e6edf3',
    ],
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    colors: [
      '#1f2328',
      '#a40e26',
      '#116329',
      '#7d4e00',
      '#0550ae',
      '#6639ba',
      '#0a6069',
      '#ffffff',
    ],
  },
};
const escapeXml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const cellWidth = 8.5;
const lineHeight = 20;
const panelWidth = 96 * cellWidth + 32;
const imageWidth = panelWidth * 2 + 48;
const destination = new URL('../test/lifecycle-output-captures/', import.meta.url);
await mkdir(destination, { recursive: true });

for (const [name, theme] of Object.entries(themes)) {
  let y = 40;
  const body: string[] = [];
  const heading = (text: string, x: number, baseline: number) =>
    `<text x="${x}" y="${baseline}" fill="${theme.foreground}" font-size="16" font-weight="bold">${escapeXml(text)}</text>`;
  body.push(heading('Doctor and Install · synthetic ANSI output captures', 24, y));
  y += 40;
  for (const capture of captures) {
    body.push(heading(capture.title, 24, y));
    y += 28;
    body.push(heading('Before', 24, y), heading('After', panelWidth + 24, y));
    y += 28;
    for (const [side, lines] of [capture.before, capture.after].entries()) {
      let color = theme.foreground;
      let bold = false;
      let dim = false;
      lines.forEach((line, index) => {
        let x = side * panelWidth + 24;
        const spans: string[] = [];
        // eslint-disable-next-line no-control-regex -- Parse the captured ANSI style sequences.
        for (const part of line.split(/(\u001b\[[\d;]*m)/)) {
          if (part.startsWith('\u001b[')) {
            const codes = part.slice(2, -1).split(';').map(Number);
            for (let i = 0; i < codes.length; i++) {
              const code = codes[i]!;
              if (code === 0) {
                color = theme.foreground;
                bold = false;
                dim = false;
              } else if (code === 1) bold = true;
              else if (code === 2) dim = true;
              else if (code === 22) {
                bold = false;
                dim = false;
              } else if (code === 39) color = theme.foreground;
              else if (code >= 30 && code <= 37) color = theme.colors[code - 30]!;
              else if (code === 38 && codes[i + 1] === 2) {
                color = `rgb(${codes.slice(i + 2, i + 5).join(',')})`;
                i += 4;
              }
            }
          } else if (part) {
            const width = stringWidth(part) * cellWidth;
            spans.push(
              `<tspan x="${x}" fill="${color}" opacity="${dim ? 0.65 : 1}" font-weight="${bold ? 'bold' : 'normal'}" textLength="${width}" lengthAdjust="spacingAndGlyphs">${escapeXml(part)}</tspan>`,
            );
            x += width;
          }
        }
        body.push(
          `<text y="${y + index * lineHeight}" xml:space="preserve">${spans.join('')}</text>`,
        );
      });
    }
    y += Math.max(capture.before.length, capture.after.length) * lineHeight + 40;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${y}" viewBox="0 0 ${imageWidth} ${y}" role="img" aria-label="Doctor and Install before and after on a ${name} terminal palette"><rect width="100%" height="100%" fill="${theme.background}"/><g font-family="Menlo, Consolas, monospace" font-size="14">${body.join('\n')}</g></svg>\n`;
  await writeFile(new URL(`${name}.svg`, destination), svg);
}
