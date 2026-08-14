import { emit, listen } from "@tauri-apps/api/event";
import { translate } from "./i18n";
import { applyTheme } from "./theme";
import { installContextMenuGuard } from "./contextMenu";
import {
  SETTINGS_CHANGE_EVENT,
  SETTINGS_CLOSE_EVENT,
  SETTINGS_READY_EVENT,
  SETTINGS_STATE_EVENT,
  type SettingsOverlayChange,
  type SettingsOverlayState,
} from "./settings/settingsProtocol";
import "./settingsHost.css";

const root = document.querySelector<HTMLElement>("#settings-root");
if (!root) throw new Error("The settings overlay root is missing.");
installContextMenuGuard();

let state: SettingsOverlayState = { language: "ja", theme: "system" };
const isTauri = "__TAURI_INTERNALS__" in window;

if (isTauri) {
  await listen<SettingsOverlayState>(SETTINGS_STATE_EVENT, ({ payload }) => {
    state = payload;
    document.documentElement.lang = state.language;
    applyTheme(state.theme);
    render();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") requestClose();
});

render();
if (isTauri) await emit(SETTINGS_READY_EVENT);

function render(): void {
  const t = (key: Parameters<typeof translate>[1]) => translate(state.language, key);
  root.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "native-settings";
  panel.setAttribute("aria-label", t("settingsTitle"));
  panel.setAttribute("role", "menu");
  panel.append(
    createSection(t("language"), [
      { label: t("japanese"), active: state.language === "ja", change: { key: "language", value: "ja" } },
      { label: t("english"), active: state.language === "en", change: { key: "language", value: "en" } },
    ]),
    createSection(t("appearance"), [
      { label: t("system"), active: state.theme === "system", change: { key: "theme", value: "system" } },
      { label: t("light"), active: state.theme === "light", change: { key: "theme", value: "light" } },
      { label: t("dark"), active: state.theme === "dark", change: { key: "theme", value: "dark" } },
    ]),
  );
  root.append(panel);
}

function createSection(
  label: string,
  options: Array<{ label: string; active: boolean; change: SettingsOverlayChange }>,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "native-settings-section";
  const heading = document.createElement("p");
  heading.className = "native-settings-label";
  heading.textContent = label;
  const optionList = document.createElement("div");
  optionList.className = "native-settings-options";
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `native-settings-option${option.active ? " native-settings-option--active" : ""}`;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-pressed", String(option.active));
    button.textContent = option.label;
    button.addEventListener("click", () => {
      state = { ...state, [option.change.key]: option.change.value } as SettingsOverlayState;
      applyTheme(state.theme);
      render();
      if (isTauri) void emit(SETTINGS_CHANGE_EVENT, option.change);
    });
    optionList.append(button);
  }
  section.append(heading, optionList);
  return section;
}

function requestClose(): void {
  if (isTauri) void emit(SETTINGS_CLOSE_EVENT);
}
