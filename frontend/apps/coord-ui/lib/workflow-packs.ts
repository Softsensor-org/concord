import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { COORD_DIR, PROJECT_ROOT } from './coord-paths';

export interface WorkflowPackFile {
  path: string;
  present: boolean;
  rows?: number;
}

export interface WorkflowPackView {
  id: string;
  title: string;
  installed: boolean;
  templatePresent: boolean;
  files: WorkflowPackFile[];
  missing: number;
}

const PACKS = [
  {
    id: 'site-seo',
    title: 'Site SEO',
    required: [
      '00-ops/seo/AUDIT-DATA-REGISTER.csv',
      '00-ops/seo/URL-REGISTRY.csv',
      '00-ops/seo/FINDING-LIFECYCLE.csv',
      '00-ops/seo/GSC-REQUEST-QUEUE.csv',
      '00-ops/seo/SEO-GOVERNANCE-CONTRACT.md',
      '00-ops/seo/SEO-EVIDENCE-CONTRACT.md'
    ]
  },
  {
    id: 'daily-analytics',
    title: 'Daily Analytics',
    required: [
      '00-ops/data/DATA-REGISTER.csv',
      '00-ops/data/PIPELINE-REGISTER.csv',
      '00-ops/data/ANALYTICS-GUIDANCE.md',
      '00-ops/data/update-log.csv',
      '00-ops/data/MISMATCH-LEDGER.csv',
      '00-ops/utilities/utility-register.csv',
      '00-ops/utilities/UTILITY-GOVERNANCE.md'
    ]
  }
];

function countCsvRows(absPath: string): number | undefined {
  if (!absPath.endsWith('.csv')) return undefined;
  try {
    const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    return Math.max(0, lines.length - 1);
  } catch {
    return undefined;
  }
}

export function loadWorkflowPacks(): WorkflowPackView[] {
  return PACKS.map((pack) => {
    const templatePresent = fs.existsSync(path.join(COORD_DIR, 'product', 'workflow-packs', pack.id, 'templates'));
    const files = pack.required.map((rel) => {
      const abs = path.join(PROJECT_ROOT, rel);
      const present = fs.existsSync(abs);
      return {
        path: rel,
        present,
        rows: present ? countCsvRows(abs) : undefined
      };
    });
    return {
      id: pack.id,
      title: pack.title,
      installed: files.some((file) => file.present),
      templatePresent,
      files,
      missing: files.filter((file) => !file.present).length
    };
  });
}
