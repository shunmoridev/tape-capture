import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

type InfoTipProps = {
  label: string;
  text?: string;
  children?: ReactNode;
  placement?: "left" | "right";
  boundary?: "nearest" | "setup-column";
};

type PopupPosition = Pick<CSSProperties, "top" | "left" | "width" | "maxHeight"> & {
  side: "above" | "below";
};

export function InfoTip({
  label,
  text,
  children,
  placement = "left",
  boundary = "nearest",
}: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const popupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeWhenOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target)
        && !popupRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const popup = popupRef.current;
      if (!anchor || !popup) return;

      const boundaryElement = boundary === "setup-column"
        ? document.querySelector(".setup-column")
        : rootRef.current?.closest(".setup-column");
      const horizontalBounds = boundaryElement?.getBoundingClientRect()
        ?? document.documentElement.getBoundingClientRect();
      const viewportMargin = 12;
      const gap = 7;
      const width = Math.min(320, Math.max(240, horizontalBounds.width - 24));
      const maxHeight = Math.max(160, window.innerHeight - viewportMargin * 2);

      popup.style.width = `${width}px`;
      popup.style.maxHeight = `${maxHeight}px`;
      const popupHeight = popup.getBoundingClientRect().height;

      const desiredLeft = placement === "right"
        ? anchor.right - width + 8
        : anchor.left - 8;
      const minLeft = horizontalBounds.left + viewportMargin;
      const maxLeft = Math.max(
        minLeft,
        horizontalBounds.right - width - viewportMargin,
      );
      const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

      const belowTop = anchor.bottom + gap;
      const aboveTop = anchor.top - gap - popupHeight;
      const availableBelow = window.innerHeight - viewportMargin - belowTop;
      const availableAbove = anchor.top - gap - viewportMargin;
      const side = popupHeight > availableBelow && availableAbove > availableBelow
        ? "above"
        : "below";
      const desiredTop = side === "above" ? aboveTop : belowTop;
      const top = Math.min(
        Math.max(desiredTop, viewportMargin),
        window.innerHeight - viewportMargin - popupHeight,
      );

      setPosition({ top, left, width, maxHeight, side });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [boundary, open, placement]);

  return (
    <div
      ref={rootRef}
      className={`info-tip info-tip--${placement}${open ? " info-tip--open" : ""}`}
    >
      <button
        type="button"
        className="info-tip-button"
        aria-label={label}
        aria-controls={popupId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        i
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          id={popupId}
          className={`info-tip-popup info-tip-popup--open info-tip-popup--${position?.side ?? "below"}`}
          role="tooltip"
          style={position
            ? {
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }
            : { top: 0, left: 0, visibility: "hidden" }}
        >
          {children ?? text}
        </div>,
        document.body,
      )}
    </div>
  );
}
