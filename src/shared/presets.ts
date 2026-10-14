/* Catálogo de formatos y presets compartidos entre backend y UI */

export interface ExtDef {
  ext: string;
  group: 'texto' | 'web' | 'código' | 'datos' | 'documentos';
  supported: boolean;
  note?: string;
}

export const EXTENSIONS: ExtDef[] = [
  { ext: '.txt', group: 'texto', supported: true },
  { ext: '.md', group: 'texto', supported: true },
  { ext: '.mdx', group: 'texto', supported: true },
  { ext: '.rst', group: 'texto', supported: true },
  { ext: '.adoc', group: 'texto', supported: true },
  { ext: '.log', group: 'texto', supported: true },

  { ext: '.html', group: 'web', supported: true },
  { ext: '.htm', group: 'web', supported: true },
  { ext: '.css', group: 'web', supported: true },
  { ext: '.scss', group: 'web', supported: true },
  { ext: '.js', group: 'web', supported: true },
  { ext: '.jsx', group: 'web', supported: true },
  { ext: '.ts', group: 'web', supported: true },
  { ext: '.tsx', group: 'web', supported: true },
  { ext: '.vue', group: 'web', supported: true },
  { ext: '.svelte', group: 'web', supported: true },

  { ext: '.json', group: 'datos', supported: true },
  { ext: '.jsonl', group: 'datos', supported: true },
  { ext: '.yaml', group: 'datos', supported: true },
  { ext: '.yml', group: 'datos', supported: true },
  { ext: '.toml', group: 'datos', supported: true },
  { ext: '.csv', group: 'datos', supported: true },
  { ext: '.tsv', group: 'datos', supported: true },
  { ext: '.xml', group: 'datos', supported: true },
  { ext: '.ini', group: 'datos', supported: true },
  { ext: '.env', group: 'datos', supported: true },

  { ext: '.py', group: 'código', supported: true },
  { ext: '.rb', group: 'código', supported: true },
  { ext: '.go', group: 'código', supported: true },
  { ext: '.rs', group: 'código', supported: true },
  { ext: '.java', group: 'código', supported: true },
  { ext: '.c', group: 'código', supported: true },
  { ext: '.cpp', group: 'código', supported: true },
  { ext: '.h', group: 'código', supported: true },
  { ext: '.hpp', group: 'código', supported: true },
  { ext: '.cs', group: 'código', supported: true },
  { ext: '.php', group: 'código', supported: true },
  { ext: '.swift', group: 'código', supported: true },
  { ext: '.kt', group: 'código', supported: true },
  { ext: '.scala', group: 'código', supported: true },
  { ext: '.sh', group: 'código', supported: true },
  { ext: '.bash', group: 'código', supported: true },
  { ext: '.ps1', group: 'código', supported: true },
  { ext: '.sql', group: 'código', supported: true },
  { ext: '.r', group: 'código', supported: true },
  { ext: '.lua', group: 'código', supported: true },
  { ext: '.dart', group: 'código', supported: true },
  { ext: '.ex', group: 'código', supported: true },
  { ext: '.hs', group: 'código', supported: true },
  { ext: '.pl', group: 'código', supported: true },
  { ext: '.proto', group: 'código', supported: true },
  { ext: '.graphql', group: 'código', supported: true },
  { ext: '.tf', group: 'código', supported: true },
  { ext: '.dockerfile', group: 'código', supported: true },
  { ext: '.makefile', group: 'código', supported: true },

  { ext: '.pdf', group: 'documentos', supported: true },
  { ext: '.docx', group: 'documentos', supported: false, note: 'próximamente' },
  { ext: '.odt', group: 'documentos', supported: false, note: 'próximamente' },
  { ext: '.pptx', group: 'documentos', supported: false, note: 'próximamente' },
  { ext: '.xlsx', group: 'documentos', supported: false, note: 'próximamente' }
];

export const SUPPORTED_EXTS = EXTENSIONS.filter((e) => e.supported).map((e) => e.ext);

/* Archivos sin extensión pero con contenido relevante */
export const SPECIAL_FILES = ['makefile', 'dockerfile', 'license', 'readme', 'procfile', 'gemfile', 'cname', 'authors', 'changelog'];

export const PRESETS: Record<string, { label: string; exts: string[] }> = {
  text: { label: 'Solo texto y Markdown', exts: ['.txt', '.md', '.mdx', '.rst', '.adoc', '.log'] },
  web: { label: 'Solo web', exts: ['.html', '.htm', '.css', '.scss', '.js', '.jsx', '.ts', '.tsx', '.json'] },
  code: { label: 'Solo código', exts: ['.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.ts', '.js', '.sql', '.sh', '.makefile', '.dockerfile'] },
  docs: { label: 'Documentos', exts: ['.pdf', '.md', '.txt', '.rst'] },
  data: { label: 'Datos y configuración', exts: ['.json', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.xml', '.ini'] },
  all: { label: 'Todo lo legible', exts: [...SUPPORTED_EXTS] }
};
