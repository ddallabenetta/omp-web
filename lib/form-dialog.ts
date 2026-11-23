import { choiceValue, fieldQuestions, textValue, type HtmlFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { loadMedia, svgMedia, type Media } from "@oh-my-pi/pi-tui/media";
import { parseHtmlForm, type FormBlock as SdkFormBlock, type HtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { FormBlock, FormDialogForm, FormDialogState } from "./form-dialog-types";

/** What `ui.formDialog` resolves to on submit: the form's data, flagged when the ask timeout submitted it. */
export interface FormDialogAnswer {
  data: HtmlFormData;
  timedOut?: boolean;
}

/** Where a picture of the form comes from; never sent to the browser. */
export type FormMediaSource = { kind: "image"; src: string } | { kind: "svg"; markup: string };

export interface PreparedFormDialog {
  /** The SDK's parse, kept to turn the browser's answer into the form's data. */
  form: HtmlForm;
  /** What the browser draws. */
  client: FormDialogForm;
  /** Pictures by the `index` of the matching `media` block. */
  media: FormMediaSource[];
}

/** The model's `<form>` HTML, split into what the browser draws and what stays on the server. */
export function prepareFormDialog(html: string): PreparedFormDialog {
  const form = parseHtmlForm(html);
  const questions = fieldQuestions(form);
  const media: FormMediaSource[] = [];

  const toClientBlocks = (blocks: SdkFormBlock[]): FormBlock[] =>
    blocks.flatMap((block): FormBlock[] => {
      switch (block.kind) {
        case "image":
          media.push({ kind: "image", src: block.src });
          return [{ kind: "media", index: media.length - 1, alt: block.alt }];
        case "svg":
          media.push({ kind: "svg", markup: block.markup });
          return [{ kind: "media", index: media.length - 1, alt: block.alt }];
        case "field":
          // A control without a name submits nothing, so the form does not draw it.
          if (!block.field.name) return [];
          return [{ kind: "field", field: { ...block.field, question: questions.get(block.field) ?? block.field.name } }];
        default:
          return [block];
      }
    });

  const client: FormDialogForm = {
    sections: form.sections.map((section) => ({ title: section.title, blocks: toClientBlocks(section.blocks) })),
  };
  return { form, client, media };
}

/**
 * The form data a state submits. A control the state does not mention keeps its
 * preselected or prefilled value, so `{ choices: {}, texts: {} }` is the form's
 * defaults. Computed with the SDK's own helpers, as the TUI's form does.
 */
export function formDataFromState(form: HtmlForm, state: FormDialogState): HtmlFormData {
  const data: HtmlFormData = Object.fromEntries(form.hidden);
  for (const field of form.fields) {
    if (!field.name) continue;
    let value;
    if (field.kind === "text") {
      const text = Object.hasOwn(state.texts, field.name) ? state.texts[field.name] : field.value;
      value = textValue(field, text);
    } else {
      const picked = Object.hasOwn(state.choices, field.name) ? state.choices[field.name] : undefined;
      const checked = picked
        ? new Set(picked.checked)
        : new Set(field.options.flatMap((option, index) => (option.checked ? [index] : [])));
      value = choiceValue(field, checked, picked?.other);
    }
    if (value !== undefined) data[field.name] = value;
  }
  return data;
}

/** The browser's JSON answer, or undefined when it is not a well-formed state. */
export function parseFormDialogState(json: string): FormDialogState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.choices) || !isRecord(parsed.texts)) return undefined;
  if (parsed.timedOut !== undefined && typeof parsed.timedOut !== "boolean") return undefined;

  const choiceEntries: [string, { checked: number[]; other?: string }][] = [];
  for (const [name, choice] of Object.entries(parsed.choices)) {
    if (!isRecord(choice) || !Array.isArray(choice.checked)) return undefined;
    if (!choice.checked.every((index) => Number.isSafeInteger(index))) return undefined;
    if (choice.other !== undefined && typeof choice.other !== "string") return undefined;
    choiceEntries.push([name, { checked: choice.checked as number[], ...(choice.other !== undefined ? { other: choice.other } : {}) }]);
  }
  const textEntries: [string, string][] = [];
  for (const [name, text] of Object.entries(parsed.texts)) {
    if (typeof text !== "string") return undefined;
    textEntries.push([name, text]);
  }
  return {
    choices: Object.fromEntries(choiceEntries),
    texts: Object.fromEntries(textEntries),
    ...(parsed.timedOut ? { timedOut: true } : {}),
  };
}

/** A form picture's bytes: loaded with the SDK's loader (URL, data URI or path from the session cwd, size-capped). */
export function loadFormMedia(source: FormMediaSource, cwd: string, signal?: AbortSignal): Promise<Media> {
  return source.kind === "svg" ? Promise.resolve(svgMedia(source.markup)) : loadMedia(source.src, { cwd, signal });
}
