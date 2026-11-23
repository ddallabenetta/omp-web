"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { FormBlock, FormChoiceField, FormDialogForm, FormDialogState, FormField, FormSpan, FormTextField } from "@/lib/form-dialog-types";

type FormRequest = {
  id: string;
  form: FormDialogForm;
  mediaPath?: string;
  expiresAt?: number;
};

type ChoiceState = { checked: number[]; other: string };

const controlStyle: CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 7,
  outline: "none",
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const buttonStyle: CSSProperties = {
  padding: "7px 12px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
};

/** A form's controls: only named ones are ever sent, so those are the only ones the server draws. */
function fieldsOf(form: FormDialogForm): FormField[] {
  return form.sections.flatMap((section) =>
    section.blocks.flatMap((block) => (block.kind === "field" ? [block.field] : [])));
}

function initialChoices(fields: FormField[]): Record<string, ChoiceState> {
  return Object.fromEntries(
    fields.flatMap((field) =>
      field.kind === "choice"
        ? [[field.name, { checked: field.options.flatMap((option, index) => (option.checked ? [index] : [])), other: "" }]]
        : []),
  );
}

function initialTexts(fields: FormField[]): Record<string, string> {
  return Object.fromEntries(fields.flatMap((field) => (field.kind === "text" ? [[field.name, field.value]] : [])));
}

/** A checkbox group or multi-select reports an array, so "required" means at least one. */
const isArrayChoice = (field: FormChoiceField) => field.multi && field.options.length > 1;

function Spans({ spans }: { spans: FormSpan[] }) {
  return (
    <>
      {spans.map((span, spanIndex) => {
        const lines = span.text.split("\n").flatMap((line, lineIndex) => (lineIndex === 0 ? [line] : [<br key={`br${lineIndex}`} />, line]));
        if (span.style === "code") return <code key={spanIndex} style={{ fontFamily: "var(--font-mono)", background: "var(--bg-subtle)", padding: "0 3px", borderRadius: 3 }}>{lines}</code>;
        if (span.style === "strong") return <strong key={spanIndex}>{lines}</strong>;
        if (span.style === "em") return <em key={spanIndex}>{lines}</em>;
        return <span key={spanIndex}>{lines}</span>;
      })}
    </>
  );
}

function MediaImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (failed) return <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{alt || t("chat.formMediaFailed")}</div>;
  // eslint-disable-next-line @next/next/no-img-element -- served by the session's own form-media route
  return <img src={src} alt={alt} onError={() => setFailed(true)} style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 6 }} />;
}

function BlockView({ block, mediaPath, renderField }: { block: FormBlock; mediaPath?: string; renderField: (field: FormField) => ReactNode }) {
  switch (block.kind) {
    case "text":
      return block.heading
        ? <div style={{ fontSize: 13, fontWeight: 680, color: "var(--text)" }}><Spans spans={block.spans} /></div>
        : <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--text)" }}><Spans spans={block.spans} /></p>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, lineHeight: 1.55 }}>
          {block.items.map((item, itemIndex) => <li key={itemIndex}><Spans spans={item} /></li>)}
        </List>
      );
    }
    case "pre":
      return <pre style={{ margin: 0, padding: "8px 10px", overflowX: "auto", background: "var(--bg-subtle)", borderRadius: 6, fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{block.text}</pre>;
    case "table":
      return (
        <div className="markdown-table-wrap">
          <table>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    const Cell = rowIndex < block.headerRows ? "th" : "td";
                    return <Cell key={cellIndex}><Spans spans={cell} /></Cell>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "media":
      return mediaPath ? <MediaImage src={`${mediaPath}/${block.index}`} alt={block.alt} /> : null;
    case "field":
      return <>{renderField(block.field)}</>;
  }
}

export function FormDialog({
  request,
  onRespond,
}: {
  request: FormRequest;
  onRespond: (response: { value: string } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const fields = useMemo(() => fieldsOf(request.form), [request.form]);
  const [choices, setChoices] = useState(() => initialChoices(fields));
  const [texts, setTexts] = useState(() => initialTexts(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const formRef = useRef<HTMLFormElement>(null);

  const toState = useCallback((timedOut: boolean): FormDialogState => ({
    choices: Object.fromEntries(
      Object.entries(choices).map(([name, choice]) => [
        name,
        { checked: choice.checked, ...(choice.other.trim() ? { other: choice.other } : {}) },
      ]),
    ),
    texts,
    ...(timedOut ? { timedOut: true } : {}),
  }), [choices, texts]);
  // The deadline fires from a timer created once, so it reads the state through a ref.
  const stateRef = useRef(toState);
  stateRef.current = toState;

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    const deadline = request.expiresAt;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // The ask timeout the user configured submits what has been filled in so far.
    const expiry = setTimeout(
      () => onRespond({ value: JSON.stringify(stateRef.current(true)) }),
      Math.max(0, deadline - Date.now()),
    );
    return () => {
      clearInterval(tick);
      clearTimeout(expiry);
    };
  }, [request.expiresAt, onRespond]);

  const choiceError = (field: FormChoiceField): string | undefined => {
    if (!field.required) return undefined;
    const choice = choices[field.name];
    const answered = (choice?.checked.some((index) => !field.options[index]?.disabled) ?? false) || (choice?.other.trim() ?? "") !== "";
    if (answered) return undefined;
    return isArrayChoice(field) ? t("chat.formChooseAtLeastOne") : t("chat.formRequired");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    for (const field of fields) {
      if (field.kind !== "choice") continue;
      const message = choiceError(field);
      if (message) found[field.name] = message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onRespond({ value: JSON.stringify(toState(false)) });
  };

  const setChoice = (field: FormChoiceField, next: Partial<ChoiceState>) => {
    setChoices((current) => ({ ...current, [field.name]: { ...current[field.name], ...next } }));
    setErrors((current) => (field.name in current ? Object.fromEntries(Object.entries(current).filter(([name]) => name !== field.name)) : current));
  };

  const toggleOption = (field: FormChoiceField, index: number) => {
    const checked = choices[field.name]?.checked ?? [];
    if (field.multi) {
      setChoice(field, { checked: checked.includes(index) ? checked.filter((item) => item !== index) : [...checked, index] });
    } else {
      // A radio answer replaces a typed "Other" one.
      setChoice(field, { checked: [index], other: "" });
    }
  };

  const renderChoice = (field: FormChoiceField, fieldIndex: number) => {
    const state = choices[field.name] ?? { checked: [], other: "" };
    const label = field.label.length > 0 ? <label style={{ display: "block", marginBottom: 5, fontSize: 12, fontWeight: 600 }}><Spans spans={field.label} /></label> : null;
    if (field.select) {
      const placeholderShown = !field.multi && state.checked.length === 0;
      return (
        <div>
          {label}
          <select
            aria-label={field.question}
            multiple={field.multi}
            required={field.required}
            value={field.multi ? state.checked.map(String) : state.checked[0] === undefined ? "" : String(state.checked[0])}
            onChange={(event) => setChoice(field, {
              checked: field.multi
                ? Array.from(event.target.selectedOptions, (option) => Number(option.value))
                : event.target.value === "" ? [] : [Number(event.target.value)],
            })}
            style={controlStyle}
          >
            {placeholderShown && <option value="">{t("chat.formSelectPlaceholder")}</option>}
            {field.options.map((option, index) => (
              <option key={index} value={String(index)} disabled={option.disabled}>{option.label.map((span) => span.text).join("")}</option>
            ))}
          </select>
        </div>
      );
    }
    const inputType = field.multi ? "checkbox" : "radio";
    return (
      <div role={field.multi ? "group" : "radiogroup"} aria-label={field.question} style={{ display: "grid", gap: 6 }}>
        {label}
        {field.options.map((option, index) => (
          <label key={index} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, cursor: option.disabled ? "not-allowed" : "pointer", opacity: option.disabled ? 0.5 : 1 }}>
            <input
              type={inputType}
              name={`${request.id}:${fieldIndex}`}
              checked={state.checked.includes(index)}
              disabled={option.disabled}
              onChange={() => toggleOption(field, index)}
              style={{ marginTop: 3, accentColor: "var(--accent)" }}
            />
            <span><Spans spans={option.label} /></span>
          </label>
        ))}
        {field.other && (
          <input
            type="text"
            value={state.other}
            onChange={(event) => setChoice(field, field.multi ? { other: event.target.value } : { other: event.target.value, checked: event.target.value.trim() ? [] : state.checked })}
            placeholder={`${t("chat.formOther")}: ${t("chat.formOtherPlaceholder")}`}
            aria-label={t("chat.formOther")}
            style={controlStyle}
          />
        )}
      </div>
    );
  };

  const renderText = (field: FormTextField) => {
    const value = texts[field.name] ?? "";
    const common = {
      value,
      required: field.required,
      placeholder: field.placeholder || undefined,
      minLength: field.minLength,
      maxLength: field.maxLength,
      "aria-label": field.question,
      onChange: (event: { target: { value: string } }) => setTexts((current) => ({ ...current, [field.name]: event.target.value })),
      style: controlStyle,
    };
    return (
      <div>
        {field.label.length > 0 && <label style={{ display: "block", marginBottom: 5, fontSize: 12, fontWeight: 600 }}><Spans spans={field.label} /></label>}
        {field.multiline
          ? <textarea {...common} rows={Math.max(field.rows, 2)} style={{ ...controlStyle, resize: "vertical" }} />
          : <input {...common} type={field.type} min={field.min} max={field.max} pattern={field.pattern} />}
      </div>
    );
  };

  const fieldIndexes = useMemo(() => new Map(fields.map((field, index) => [field, index])), [fields]);
  const renderField = (field: FormField) => {
    const error = field.kind === "choice" ? errors[field.name] : undefined;
    return (
      <div>
        {field.kind === "choice" ? renderChoice(field, fieldIndexes.get(field) ?? 0) : renderText(field)}
        {error && <div role="alert" style={{ marginTop: 4, color: "var(--danger)", fontSize: 11 }}>{error}</div>}
      </div>
    );
  };

  const remainingSeconds = request.expiresAt === undefined ? null : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  return (
    <div
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape") onRespond({ cancelled: true });
        else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") formRef.current?.requestSubmit();
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "color-mix(in srgb, #000 26%, transparent)",
        backdropFilter: "blur(2px)",
      }}
    >
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.agentQuestion")}
        onSubmit={submit}
        style={{
          display: "flex",
          flexDirection: "column",
          width: "min(720px, 100%)",
          maxHeight: "min(780px, calc(100dvh - 32px))",
          overflow: "hidden",
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.32)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <span
            aria-hidden="true"
            style={{ display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: 6, background: "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))", color: "var(--accent)", fontSize: 13, fontWeight: 750 }}
          >
            ?
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 680 }}>{t("chat.agentQuestion")}</div>
            <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11 }}>{t("chat.formHint")}</div>
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: 16, display: "grid", gap: 14 }}>
          {request.form.sections.map((section, sectionIndex) => (
            <section
              key={sectionIndex}
              style={section.title.length > 0 ? { padding: 14, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", display: "grid", gap: 10 } : { display: "grid", gap: 10 }}
            >
              {section.title.length > 0 && <div style={{ color: "var(--accent)", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}><Spans spans={section.title} /></div>}
              {section.blocks.map((block, blockIndex) => (
                <BlockView key={blockIndex} block={block} mediaPath={request.mediaPath} renderField={renderField} />
              ))}
            </section>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          {remainingSeconds !== null && (
            <span style={{ marginRight: "auto", fontSize: 11, color: "var(--text-dim)" }}>{t("chat.extensionExpiresIn", { seconds: remainingSeconds })}</span>
          )}
          <button type="button" onClick={() => onRespond({ cancelled: true })} style={buttonStyle}>{t("chat.cancel")}</button>
          <button
            type="submit"
            style={{ ...buttonStyle, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontWeight: 650 }}
          >
            {t("chat.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
