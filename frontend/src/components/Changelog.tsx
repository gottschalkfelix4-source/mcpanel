import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Sparkles } from 'lucide-react';
import changelog from 'virtual:changelog';
import { Badge, Panel } from './ui';

const REPO_URL = 'https://github.com/gottschalkfelix4-source/mcpanel/blob/main/CHANGELOG.md';

interface Section {
  title: string;
  blocks: { heading: string | null; items: string[]; text: string[] }[];
}

/**
 * Liest genau das Format, in dem CHANGELOG.md geschrieben ist: `##` je
 * Fassung, `###` für Gruppen, Spiegelstriche. Bewusst kein Markdown-Paket und
 * kein innerHTML – alles wird als React-Text gerendert.
 */
export function parseChangelog(source: string): Section[] {
  const sections: Section[] = [];
  let section: Section | null = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      section = { title: line.slice(3).replace(/^\[(.*)\]$/, '$1'), blocks: [{ heading: null, items: [], text: [] }] };
      sections.push(section);
      continue;
    }
    if (!section) continue;
    const block = section.blocks[section.blocks.length - 1];
    if (line.startsWith('### ')) {
      section.blocks.push({ heading: line.slice(4), items: [], text: [] });
    } else if (/^[-*] /.test(line)) {
      block.items.push(line.slice(2));
    } else if (/^\s+\S/.test(line) && block.items.length) {
      block.items[block.items.length - 1] += ` ${line.trim()}`;
    } else if (line.trim()) {
      block.text.push(line.trim());
    }
  }
  return sections;
}

/** **fett** und `code` – mehr kommt im Änderungsprotokoll nicht vor. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i} className="text-stone-100">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={i} className="font-mono text-xs text-diamond">{part.slice(1, -1)}</code>;
    return part;
  });
}

export default function Changelog({ version }: { version: string | null }) {
  const sections = useMemo(() => parseChangelog(changelog), []);
  const [open, setOpen] = useState<number>(0);

  return (
    <Panel
      title="Was ist neu"
      icon={<Sparkles size={16} />}
      actions={<Badge tone="blue">{version ? `Fassung ${version}` : 'eigener Bau'}</Badge>}
    >
      {sections.length === 0 ? (
        <p className="text-sm text-stone-400">
          Diesem Bau liegt kein Änderungsprotokoll bei.{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-gold hover:underline">
            Auf GitHub ansehen <ExternalLink size={11} />
          </a>
        </p>
      ) : (
        <div className="divide-y divide-stone-700 border border-stone-950">
          {sections.map((section, index) => (
            <div key={section.title}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-semibold text-stone-100 hover:bg-stone-600/[0.28]"
                onClick={() => setOpen(open === index ? -1 : index)}
                aria-expanded={open === index}
              >
                {open === index ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                {section.title}
              </button>
              {open === index && (
                <div className="space-y-3 px-4 pb-4 text-sm text-stone-300">
                  {section.blocks.map((block, b) => (
                    <div key={b} className="space-y-1.5">
                      {block.heading && <h3 className="heading text-[13px] text-grass-light">{block.heading}</h3>}
                      {block.text.map((t, i) => <p key={i}>{inline(t)}</p>)}
                      {block.items.length > 0 && (
                        <ul className="list-disc space-y-1 pl-5">
                          {block.items.map((item, i) => <li key={i}>{inline(item)}</li>)}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
