import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MessageKey } from "../i18n";
import type { Language, ThemePreference } from "../models";
import { settingsOverlay } from "../settings/settingsOverlay";
import {
  DISMISS_OVERLAYS_EVENT,
  SETTINGS_CHANGE_EVENT,
  SETTINGS_CLOSE_EVENT,
  SETTINGS_READY_EVENT,
  type SettingsOverlayChange,
  type SettingsOverlayState,
} from "../settings/settingsProtocol";

interface Props {
  language: Language;
  theme: ThemePreference;
  t: (key: MessageKey) => string;
  onLanguageChange: (language: Language) => void;
  onThemeChange: (theme: ThemePreference) => void;
  onError: (cause: unknown) => void;
}

export function SettingsMenu({ language, theme, t, onLanguageChange, onThemeChange, onError }: Props) {
  const isTauri = "__TAURI_INTERNALS__" in window;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const settingsRef = useRef<SettingsOverlayState>({ language, theme });
  const callbacksRef = useRef({ onLanguageChange, onThemeChange, onError });
  settingsRef.current = { language, theme };
  callbacksRef.current = { onLanguageChange, onThemeChange, onError };

  const changeOpen = useCallback((nextOpen: boolean) => {
    openRef.current = nextOpen;
    setOpen(nextOpen);
    if (!isTauri) return;
    const action = nextOpen
      ? settingsOverlay.open(settingsRef.current, rootRef.current?.getBoundingClientRect())
      : settingsOverlay.close();
    void action.catch((cause) => callbacksRef.current.onError(cause));
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let cleanup: UnlistenFn[] = [];
    void Promise.all([
      listen(SETTINGS_READY_EVENT, () => {
        if (openRef.current) {
          void settingsOverlay.sync(settingsRef.current)
            .catch((cause) => callbacksRef.current.onError(cause));
        }
      }),
      listen<SettingsOverlayChange>(SETTINGS_CHANGE_EVENT, ({ payload }) => {
        if (payload.key === "language" && (payload.value === "ja" || payload.value === "en")) {
          callbacksRef.current.onLanguageChange(payload.value);
        }
        if (payload.key === "theme" && ["system", "light", "dark"].includes(payload.value)) {
          callbacksRef.current.onThemeChange(payload.value as ThemePreference);
        }
      }),
      listen(SETTINGS_CLOSE_EVENT, () => changeOpen(false)),
      listen(DISMISS_OVERLAYS_EVENT, () => changeOpen(false)),
    ]).then((unlisteners) => {
      if (active) cleanup = unlisteners;
      else unlisteners.forEach((unlisten) => unlisten());
    }).catch((cause) => callbacksRef.current.onError(cause));
    void settingsOverlay.close().catch((cause) => callbacksRef.current.onError(cause));
    return () => {
      active = false;
      cleanup.forEach((unlisten) => unlisten());
      void settingsOverlay.close().catch(() => undefined);
    };
  }, [changeOpen, isTauri]);

  useEffect(() => {
    if (isTauri && open) {
      void settingsOverlay.sync({ language, theme })
        .catch((cause) => callbacksRef.current.onError(cause));
    }
  }, [isTauri, language, open, theme]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) changeOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") changeOpen(false);
    };
    const closeOnResize = () => changeOpen(false);

    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [changeOpen, open]);

  return (
    <div className="settings-menu" ref={rootRef}>
      <button
        type="button"
        className={`settings-button ${open ? "settings-button--open" : ""}`}
        aria-label={t("settingsTitle")}
        title={t("settingsTitle")}
        aria-expanded={open}
        aria-controls={isTauri ? undefined : menuId}
        aria-haspopup="menu"
        onClick={() => changeOpen(!open)}
      >
        <span className="settings-button-glyph" aria-hidden="true">⚙</span>
      </button>

      {open && !isTauri && (
        <div id={menuId} className="settings-popover" role="group" aria-label={t("settingsTitle")}>
          <div className="settings-section">
            <p className="settings-section-label">{t("language")}</p>
            <div className="settings-options">
              {(["ja", "en"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={`settings-option ${language === value ? "settings-option--active" : ""}`}
                  aria-pressed={language === value}
                  onClick={() => onLanguageChange(value)}
                >
                  {t(value === "ja" ? "japanese" : "english")}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <p className="settings-section-label">{t("appearance")}</p>
            <div className="settings-options">
              {(["system", "light", "dark"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={`settings-option ${theme === value ? "settings-option--active" : ""}`}
                  aria-pressed={theme === value}
                  onClick={() => onThemeChange(value)}
                >
                  {t(value)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
