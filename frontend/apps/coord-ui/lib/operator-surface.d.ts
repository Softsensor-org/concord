export interface RegistryCommandMetadata {
  name: string;
  namespace: string;
  maturity: string;
  safety: string;
  role?: string;
  summary: string;
  docs: string;
  ui_palette: boolean;
  advanced?: boolean;
}

export interface PaletteCommand {
  name: string;
  namespace: string;
  maturity: string;
  safety: string;
  role: string;
  summary: string;
  docs: string;
  advanced: boolean;
  planned: boolean;
}

export interface NavigationItem {
  href: string;
  label: string;
  group: string;
  maturity: string;
}

export function buildCommandPalette(
  commands: RegistryCommandMetadata[],
  options?: { includeAdvanced?: boolean }
): PaletteCommand[];

export function visibleNavigation(
  items: NavigationItem[],
  includeAdvanced?: boolean
): NavigationItem[];
