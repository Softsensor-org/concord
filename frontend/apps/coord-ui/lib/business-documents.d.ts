import type React from 'react';

export const BUSINESS_DOCUMENTS: readonly string[];
export type DocumentState = 'available' | 'empty' | 'missing' | 'unreadable' | 'outside-root';
export interface ReadDocument {
  name: string;
  state: DocumentState;
  content: string | null;
}
export function readFixedDocuments(rootDir: string, names: readonly string[], boundaryDir?: string): ReadDocument[];
export function documentTextElement(content: string): React.ReactElement;
