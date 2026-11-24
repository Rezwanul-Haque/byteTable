// A small, safe Markdown renderer for notes (M47 E2), ported from the
// prototype's NbMarkdown: `#`/`##`/`###` headings, paragraphs, bulleted and
// numbered lists, **bold**, *italic*, `code`. Everything is rendered as React
// text, so raw HTML — `<script>` included — always shows as text.
//
// The app has one other Markdown reader (the update notes in UpdateModal),
// but it reads release-note syntax into its own layout; notes need headings
// one level down (a note's `#` sits under the notebook title) and lists.

import type { ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={key + i}>{p.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(p)) return <code key={key + i}>{p.slice(1, -1)}</code>;
    if (/^\*[^*]+\*$/.test(p)) return <em key={key + i}>{p.slice(1, -1)}</em>;
    return p;
  });
}

export function NbMarkdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const endPara = () => {
    if (para.length) {
      const k = "p" + out.length;
      out.push(<p key={k}>{inline(para.join(" "), k)}</p>);
      para = [];
    }
  };
  const endList = () => {
    if (!list) return;
    const k = "l" + out.length;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, k + i)}</li>);
    out.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
    list = null;
  };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line);
    if (!line.trim()) {
      endPara();
      endList();
    } else if (h) {
      endPara();
      endList();
      const k = "h" + out.length;
      const body = inline(h[2]!, k);
      // A note's `#` is one level under the notebook's own title.
      const level = h[1]!.length;
      out.push(
        level === 1 ? (
          <h2 key={k}>{body}</h2>
        ) : level === 2 ? (
          <h3 key={k}>{body}</h3>
        ) : (
          <h4 key={k}>{body}</h4>
        ),
      );
    } else if (li) {
      endPara();
      const ordered = !!li[1];
      if (!list || list.ordered !== ordered) {
        endList();
        list = { ordered, items: [] };
      }
      list.items.push(li[2]!);
    } else {
      endList();
      para.push(line.trim());
    }
  }
  endPara();
  endList();
  return <div className="nb-md">{out}</div>;
}
