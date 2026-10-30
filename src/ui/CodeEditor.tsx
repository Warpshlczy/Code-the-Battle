import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { pick, useLang } from '../i18n';

export interface CodeEditorHandle {
  insert: (snippet: string) => void;
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  minRows?: number;
  maxRows?: number;
  errorLines?: number[];
  disabled?: boolean;
  ariaLabel: string;
  onRun?: () => void;
  testId?: string;
  /** Hard stop: the editor refuses new lines once the limit is reached. */
  maxLines?: number;
  /** Hard stop: refuse growth once the compiled complexity exceeds the limit. */
  maxComplexity?: number;
  complexity?: number;
  maxLineChars?: number;
}

const DEFAULT_MAX_LINE_CHARS = 200;

function logicalLines(text: string): number {
  return text.split('\n').filter((l) => l.trim() !== '').length;
}

const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  {
    value,
    onChange,
    minRows = 10,
    maxRows = 24,
    errorLines = [],
    disabled,
    ariaLabel,
    onRun,
    testId,
    maxLines,
    maxComplexity,
    complexity,
    maxLineChars = DEFAULT_MAX_LINE_CHARS,
  },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lang = useLang();
  const [blocked, setBlocked] = useState<string | null>(null);

  const accept = (next: string): void => {
    if (maxLines !== undefined && logicalLines(next) > maxLines) {
      setBlocked(pick(lang, `行数已达上限 ${maxLines}，编辑器已硬停`, `Line limit ${maxLines} reached. The editor is hard-stopped.`));
      return;
    }
    if (maxComplexity !== undefined && complexity !== undefined && complexity >= maxComplexity && next.length > value.length) {
      setBlocked(pick(lang, `复杂度已达上限 ${maxComplexity}，编辑器已硬停`, `Complexity limit ${maxComplexity} reached. The editor is hard-stopped.`));
      return;
    }
    const longLine = next.split('\n').find((l) => l.length > maxLineChars);
    if (longLine) {
      setBlocked(pick(lang, `单行最多 ${maxLineChars} 字符，编辑器已硬停`, `Lines are capped at ${maxLineChars} characters. The editor is hard-stopped.`));
      return;
    }
    setBlocked(null);
    onChange(next);
  };

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    insert: (snippet: string) => {
      const el = taRef.current;
      if (!el || disabled) return;
      const marker = snippet.indexOf('|');
      const text = marker >= 0 ? snippet.replace('|', '') : snippet;
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + text + value.slice(end);
      accept(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + (marker >= 0 ? marker : text.length);
        el.setSelectionRange(pos, pos);
      });
    },
  }));

  const lines = value.split('\n');
  const rows = Math.min(maxRows, Math.max(minRows, lines.length + 1));
  const errors = new Set(errorLines);
  const used = logicalLines(value);
  const lineTone = maxLines === undefined ? '' : used >= maxLines ? 'full' : used > maxLines - 3 ? 'near' : '';
  const complexityTone = maxComplexity === undefined || complexity === undefined ? '' : complexity >= maxComplexity ? 'full' : complexity > maxComplexity - 12 ? 'near' : '';

  return (
    <div className={`code-shell ${disabled ? 'code-disabled' : ''} ${blocked ? 'code-blocked' : ''}`}>
      <div className="code-gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={errors.has(i + 1) ? 'gutter-line err' : 'gutter-line'}>
            {String(i + 1).padStart(2, '0')}
          </div>
        ))}
      </div>
      <textarea
        ref={taRef}
        className="code-input"
        value={value}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(e) => accept(e.target.value)}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const el = e.currentTarget;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            if (start !== end) return;
            const next = value.slice(0, start) + '    ' + value.slice(end);
            accept(next);
            requestAnimationFrame(() => el.setSelectionRange(start + 4, start + 4));
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onRun?.();
          }
        }}
      />
      <div className={`code-status ${lineTone || complexityTone ? 'warn' : ''}`} data-testid="code-status">
        <span className={lineTone}>
          {pick(lang, '行数', 'Lines')} {used}
          {maxLines !== undefined ? `/${maxLines}` : ''}
        </span>
        {maxComplexity !== undefined && (
          <span className={complexityTone}>
            {pick(lang, '复杂度', 'Complexity')} {complexity ?? 0}/{maxComplexity}
          </span>
        )}
        {blocked ? (
          <span className="code-block-msg">{blocked}</span>
        ) : (
          <span className="code-hint">{pick(lang, '写到上限会硬停', 'The editor hard-stops at the limit')}</span>
        )}
      </div>
    </div>
  );
});

export default CodeEditor;
