import { emit, listen } from "@tauri-apps/api/event";
import { installContextMenuGuard } from "./contextMenu";
import { translate, type MessageKey } from "./i18n";
import {
  DEFAULT_SETTINGS,
  type Language,
} from "./models";
import {
  RECORDING_SETTINGS_CLOSE_EVENT,
  RECORDING_SETTINGS_READY_EVENT,
  RECORDING_SETTINGS_SAVE_EVENT,
  RECORDING_SETTINGS_STATE_EVENT,
  RECORDING_SETTING_LIMITS,
  type RecordingSettingsOverlayState,
  type RecordingSettingsValues,
} from "./recordingSettings/recordingSettingsProtocol";
import { applyTheme } from "./theme";
import "./recordingSettingsHost.css";

const root = document.querySelector<HTMLElement>("#recording-settings-root");
if (!root) throw new Error("The recording settings root is missing.");
installContextMenuGuard();

const DEFAULT_VALUES: RecordingSettingsValues = {
  startConfirmationMs: DEFAULT_SETTINGS.startConfirmationMs,
  stopConfirmationMs: DEFAULT_SETTINGS.stopConfirmationMs,
  preRollMs: DEFAULT_SETTINGS.preRollMs,
  analysisIntervalMs: DEFAULT_SETTINGS.analysisIntervalMs,
};

const PRESETS: Array<{
  key: MessageKey;
  values: RecordingSettingsValues;
}> = [
  {
    key: "recordingPresetResponsive",
    values: {
      startConfirmationMs: 800,
      stopConfirmationMs: 5_000,
      preRollMs: 3_000,
      analysisIntervalMs: 200,
    },
  },
  {
    key: "recordingPresetStandard",
    values: DEFAULT_VALUES,
  },
  {
    key: "recordingPresetStable",
    values: {
      startConfirmationMs: 2_500,
      stopConfirmationMs: 15_000,
      preRollMs: 8_000,
      analysisIntervalMs: 500,
    },
  },
];

let state: RecordingSettingsOverlayState = {
  language: "ja",
  theme: "system",
  ...DEFAULT_VALUES,
};
const isTauri = "__TAURI_INTERNALS__" in window;

if (isTauri) {
  await listen<RecordingSettingsOverlayState>(
    RECORDING_SETTINGS_STATE_EVENT,
    ({ payload }) => {
      state = payload;
      document.documentElement.lang = state.language;
      applyTheme(state.theme);
      render();
    },
  );
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") requestClose();
});
root.addEventListener("pointerdown", (event) => {
  if (event.target === root) requestClose();
});

render();
if (isTauri) await emit(RECORDING_SETTINGS_READY_EVENT);

function render(): void {
  const t = (key: MessageKey) => translate(state.language, key);
  root.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "recording-settings-modal";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "recording-settings-title");

  const header = document.createElement("header");
  header.className = "recording-settings-header";
  const headingGroup = document.createElement("div");
  const heading = document.createElement("h1");
  heading.id = "recording-settings-title";
  heading.textContent = t("recordingSettings");
  const description = document.createElement("p");
  description.textContent = t("recordingSettingsDescription");
  headingGroup.append(heading, description);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "recording-settings-close";
  close.setAttribute("aria-label", t("cancel"));
  close.textContent = "×";
  close.addEventListener("click", requestClose);
  header.append(headingGroup, close);

  const content = document.createElement("div");
  content.className = "recording-settings-content";
  content.append(
    createPresets(t),
    createFields(t),
  );

  const footer = document.createElement("footer");
  footer.className = "recording-settings-footer";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "recording-settings-reset";
  reset.textContent = t("restoreDefaults");
  reset.addEventListener("click", () => {
    state = { ...state, ...DEFAULT_VALUES };
    render();
  });
  const actions = document.createElement("div");
  actions.className = "recording-settings-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("cancel");
  cancel.addEventListener("click", requestClose);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "recording-settings-save";
  save.textContent = t("save");
  save.addEventListener("click", () => {
    if (isTauri) void emit(RECORDING_SETTINGS_SAVE_EVENT, recordingValues(state));
  });
  actions.append(cancel, save);
  footer.append(reset, actions);

  panel.append(header, content, footer);
  root.append(panel);
  window.setTimeout(() => close.focus(), 0);
}

function createPresets(t: (key: MessageKey) => string): HTMLElement {
  const section = document.createElement("section");
  section.className = "recording-settings-section";
  const heading = document.createElement("h2");
  heading.textContent = t("recordingPreset");
  const options = document.createElement("div");
  options.className = "recording-preset-options";
  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    const active = sameRecordingValues(state, preset.values);
    button.className = `recording-preset${active ? " recording-preset--active" : ""}`;
    button.setAttribute("aria-pressed", String(active));
    button.textContent = t(preset.key);
    button.addEventListener("click", () => {
      state = { ...state, ...preset.values };
      render();
    });
    options.append(button);
  }
  section.append(heading, options);
  return section;
}

function createFields(t: (key: MessageKey) => string): HTMLElement {
  const limits = RECORDING_SETTING_LIMITS;
  const section = document.createElement("section");
  section.className = "recording-settings-section";
  const heading = document.createElement("h2");
  heading.textContent = t("automaticRecordingParameters");
  const grid = document.createElement("div");
  grid.className = "recording-setting-grid";
  grid.append(
    createRangeField({
      label: t("startConfirmation"),
      help: t("startConfirmationHelp"),
      value: state.startConfirmationMs,
      min: limits.startConfirmationMs.min,
      max: limits.startConfirmationMs.max,
      step: limits.startConfirmationMs.step,
      format: (value) => formatSeconds(value, state.language),
      update: (value) => { state = { ...state, startConfirmationMs: value }; },
    }),
    createRangeField({
      label: t("stopConfirmation"),
      help: t("stopConfirmationHelp"),
      value: state.stopConfirmationMs,
      min: limits.stopConfirmationMs.min,
      max: limits.stopConfirmationMs.max,
      step: limits.stopConfirmationMs.step,
      format: (value) => formatSeconds(value, state.language),
      update: (value) => { state = { ...state, stopConfirmationMs: value }; },
    }),
    createRangeField({
      label: t("preRoll"),
      help: t("preRollHelp"),
      value: state.preRollMs,
      min: limits.preRollMs.min,
      max: limits.preRollMs.max,
      step: limits.preRollMs.step,
      format: (value) => formatSeconds(value, state.language),
      update: (value) => { state = { ...state, preRollMs: value }; },
    }),
    createRangeField({
      label: t("analysisInterval"),
      help: t("analysisIntervalHelp"),
      value: state.analysisIntervalMs,
      min: limits.analysisIntervalMs.min,
      max: limits.analysisIntervalMs.max,
      step: limits.analysisIntervalMs.step,
      format: (value) => `${value} ms`,
      update: (value) => { state = { ...state, analysisIntervalMs: value }; },
    }),
  );
  const note = document.createElement("p");
  note.className = "recording-settings-note";
  note.textContent = t("recordingSettingsApplyNote");
  section.append(heading, grid, note);
  return section;
}

function createRangeField(options: {
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  update: (value: number) => void;
}): HTMLElement {
  const field = document.createElement("label");
  field.className = "recording-setting";
  const header = document.createElement("span");
  header.className = "recording-setting-header";
  const label = document.createElement("strong");
  label.textContent = options.label;
  const output = document.createElement("output");
  output.textContent = options.format(options.value);
  header.append(label, output);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(options.value);
  input.addEventListener("input", () => {
    const value = Number(input.value);
    options.update(value);
    output.textContent = options.format(value);
  });
  const help = document.createElement("small");
  help.textContent = options.help;
  field.append(header, input, help);
  return field;
}

function recordingValues(source: RecordingSettingsOverlayState): RecordingSettingsValues {
  return {
    startConfirmationMs: source.startConfirmationMs,
    stopConfirmationMs: source.stopConfirmationMs,
    preRollMs: source.preRollMs,
    analysisIntervalMs: source.analysisIntervalMs,
  };
}

function sameRecordingValues(
  left: RecordingSettingsValues,
  right: RecordingSettingsValues,
): boolean {
  return left.startConfirmationMs === right.startConfirmationMs
    && left.stopConfirmationMs === right.stopConfirmationMs
    && left.preRollMs === right.preRollMs
    && left.analysisIntervalMs === right.analysisIntervalMs;
}

function formatSeconds(milliseconds: number, language: Language): string {
  const seconds = milliseconds / 1_000;
  const value = Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1);
  return language === "ja" ? `${value} 秒` : `${value} s`;
}

function requestClose(): void {
  if (isTauri) void emit(RECORDING_SETTINGS_CLOSE_EVENT);
}
