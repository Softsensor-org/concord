export type UrsInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: UrsInline[] }
  | { type: 'em'; children: UrsInline[] };

export interface UrsListItem {
  inline: UrsInline[];
  children: UrsBlock[];
}

export type UrsTableAlign = 'left' | 'center' | 'right' | null;

export type UrsBlock =
  | { type: 'heading'; level: number; line: number; inline: UrsInline[] }
  | { type: 'paragraph'; inline: UrsInline[] }
  | { type: 'list'; ordered: boolean; start: number | null; items: UrsListItem[] }
  | { type: 'table'; header: UrsInline[][]; align: UrsTableAlign[]; rows: UrsInline[][][] }
  | { type: 'hr' }
  | { type: 'code'; lang: string | null; text: string };

export function parseUrsMarkdown(raw: string): UrsBlock[];
export function parseUrsInline(text: string): UrsInline[];
