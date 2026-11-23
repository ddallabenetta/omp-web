/**
 * Wire types of the browser form dialog (`ui.formDialog`). The server parses the
 * model's HTML with the SDK's own parser and ships this reduced, already-safe
 * shape: no raw HTML and no media sources reach the browser. Pure types, so the
 * client can import them without pulling the SDK into the bundle.
 */

export type FormSpanStyle = "code" | "strong" | "em";

/** A run of inline text; `"\n"` inside `text` is a hard line break. */
export interface FormSpan {
  text: string;
  style?: FormSpanStyle;
}

export interface FormChoiceOption {
  value: string;
  label: FormSpan[];
  checked: boolean;
  disabled: boolean;
}

/** A radio group, checkbox group or `<select>`. */
export interface FormChoiceField {
  kind: "choice";
  name: string;
  /** Checkbox group or multi-select. */
  multi: boolean;
  /** From a `<select>`: drawn as a dropdown, not option rows. */
  select: boolean;
  /** The UI offers a free-text "Other" answer. */
  other: boolean;
  label: FormSpan[];
  options: FormChoiceOption[];
  required: boolean;
  /** What the field asks, resolved by the SDK from its label or the text before it. */
  question: string;
}

/** A single-line `<input>` or a `<textarea>`. */
export interface FormTextField {
  kind: "text";
  name: string;
  /** The `<input type>`; `textarea` for textareas. */
  type: string;
  multiline: boolean;
  label: FormSpan[];
  value: string;
  placeholder: string;
  required: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  rows: number;
  question: string;
}

export type FormField = FormChoiceField | FormTextField;

export type FormBlock =
  | { kind: "text"; spans: FormSpan[]; heading: boolean }
  | { kind: "list"; items: FormSpan[][]; ordered: boolean }
  | { kind: "pre"; text: string }
  | { kind: "table"; rows: FormSpan[][][]; headerRows: number }
  /** An `<img>` or inline `<svg>`, fetched from the session's form-media route by `index`. */
  | { kind: "media"; index: number; alt: string }
  | { kind: "field"; field: FormField };

export interface FormSection {
  title: FormSpan[];
  blocks: FormBlock[];
}

export interface FormDialogForm {
  sections: FormSection[];
}

/** What the browser reports back: its raw control state, turned into form data server-side. */
export interface FormDialogState {
  /** Checked option indices and the typed "Other" text, by choice field name. */
  choices: Record<string, { checked: number[]; other?: string }>;
  /** Text of every text field, by name. */
  texts: Record<string, string>;
  /** The browser submitted at the user-configured ask timeout. */
  timedOut?: boolean;
}
