import { Fragment, type ReactNode } from "react";

// 轻量 Markdown 渲染：输出 React 元素而非 HTML 字符串，天然免注入。
// 支持常用子集：标题 / 列表 / 表格 / 代码块 / 引用 / 分隔线 / 行内样式。

const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/;

function renderInline(src: string, keyPrefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = src;
  let i = 0;
  while (rest) {
    const m = INLINE_RE.exec(rest);
    if (!m || m.index === undefined) {
      out.push(<Fragment key={`${keyPrefix}t${i++}`}>{rest}</Fragment>);
      break;
    }
    if (m.index > 0)
      out.push(
        <Fragment key={`${keyPrefix}t${i++}`}>{rest.slice(0, m.index)}</Fragment>,
      );
    const tok = m[0];
    const k = `${keyPrefix}m${i++}`;
    if (tok.startsWith("`")) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**") || tok.startsWith("__"))
      out.push(<b key={k}>{renderInline(tok.slice(2, -2), k)}</b>);
    else if (tok.startsWith("~~"))
      out.push(<del key={k}>{renderInline(tok.slice(2, -2), k)}</del>);
    else if (tok.startsWith("[")) {
      const close = tok.indexOf("](");
      out.push(
        <a key={k} href={tok.slice(close + 2, -1)} target="_blank" rel="noreferrer">
          {tok.slice(1, close)}
        </a>,
      );
    } else out.push(<i key={k}>{renderInline(tok.slice(1, -1), k)}</i>);
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

function renderListBlock(
  lines: string[],
  ordered: boolean,
  key: string | number,
): ReactNode {
  const items: string[] = [];
  for (const line of lines) {
    const m = ordered
      ? /^\s*\d+[.)]\s+(.*)$/.exec(line)
      : /^\s*[-*+]\s+(.*)$/.exec(line);
    if (m && (ordered || /^\s*[-*+]\s+/.test(line))) items.push(m[1]);
    else if (items.length && /^\s{2,}\S/.test(line))
      items[items.length - 1] += `\n${line.trim()}`;
    else if (items.length) items[items.length - 1] += `\n${line.trim()}`;
  }
  const L = ordered ? "ol" : "ul";
  return (
    <L key={key}>
      {items.map((item, i) => (
        <li key={i}>
          {item.split("\n").map((seg, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {renderInline(seg, `${i}-${j}`)}
            </Fragment>
          ))}
        </li>
      ))}
    </L>
  );
}

function renderTable(rows: string[], key: string | number): ReactNode {
  const cells = (line: string) =>
    line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return (
    <table key={key}>
      <thead>
        <tr>
          {head.map((c, i) => (
            <th key={i}>{renderInline(c, `h${i}`)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, r) => (
          <tr key={r}>
            {row.map((c, i) => (
              <td key={i}>{renderInline(c, `${r}-${i}`)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderBlocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)/.exec(line.trim());
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```"))
        buf.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const H = `h${heading[1].length}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      out.push(<H key={key++}>{renderInline(heading[2], `hd${key}`)}</H>);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={key++}>{renderBlocks(buf.join("\n").split("\n"))}</blockquote>,
      );
      continue;
    }
    const listOrdered = /^\s*\d+[.)]\s+/.test(line);
    const listUnordered = /^\s*[-*+]\s+/.test(line);
    if (listOrdered || listUnordered) {
      const buf: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (listOrdered && !/^\s*\d+[.)]\s+/.test(l)) {
          if (l.trim() && !/^\s{2,}/.test(l)) break;
          if (!l.trim()) {
            const next = lines[i + 1] ?? "";
            if (!/^\s*\d+[.)]\s+|^\s{2,}\S/.test(next)) break;
          }
        } else if (listUnordered && !/^\s*[-*+]\s+/.test(l)) {
          if (l.trim() && !/^\s{2,}/.test(l)) break;
          if (!l.trim()) {
            const next = lines[i + 1] ?? "";
            if (!/^\s*[-*+]\s+|^\s{2,}\S/.test(next)) break;
          }
        }
        buf.push(l);
        i++;
      }
      out.push(renderListBlock(buf, listOrdered, key++));
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? "")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) buf.push(lines[i++]);
      out.push(renderTable(buf, key++));
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s|^\s*[-*+]\s|^\s*\d+[.)]\s|^```|^\s*>|^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    )
      para.push(lines[i++]);
    out.push(
      <p key={key++}>
        {para.map((seg, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {renderInline(seg, `p${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

export default function Markdown({ text }: { text: string }) {
  if (!text) return null;
  return <div className="md">{renderBlocks(text.replace(/\r\n/g, "\n").split("\n"))}</div>;
}
