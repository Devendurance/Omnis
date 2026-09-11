"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUpRight, Info, X } from "lucide-react";
import { previewMessage } from "@/lib/ui-model";
import { containDialogFocus } from "@/lib/dialog-focus";

const PreviewContext = createContext<(action: string) => void>(() => {});
export function usePreview() {
  return useContext(PreviewContext);
}

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [action, setAction] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (action) dialog.current?.showModal();
  }, [action]);
  function close() {
    dialog.current?.close();
    setAction(null);
    trigger.current?.focus();
  }
  function open(nextAction: string) {
    trigger.current = document.activeElement as HTMLElement;
    setAction(nextAction);
  }
  return (
    <PreviewContext value={open}>
      {children}
      <dialog
        className="preview-dialog"
        ref={dialog}
        aria-labelledby="preview-title"
        aria-describedby="preview-description"
        onCancel={close}
        onKeyDown={containDialogFocus}
        onClose={() => {
          setAction(null);
          trigger.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === dialog.current) {
            const rect = dialog.current.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              close();
          }
        }}
      >
        <button
          className="icon-button dialog-close"
          onClick={close}
          aria-label="Close preview notice"
          autoFocus
        >
          <X size={20} />
        </button>
        <span className="empty-symbol">
          <Info size={24} aria-hidden="true" />
        </span>
        <p className="eyebrow">{action}</p>
        <h2 id="preview-title">
          The interface is ready.
          <br />
          Execution comes next.
        </h2>
        <p id="preview-description">{previewMessage}</p>
        <p className="muted">
          You can explore the pages and controls. Your task input stays exactly
          as you left it.
        </p>
        <button className="button button-primary" onClick={close}>
          back to exploring <ArrowUpRight size={16} aria-hidden="true" />
        </button>
      </dialog>
    </PreviewContext>
  );
}

export function PreviewButton({
  children,
  action,
  variant = "primary",
  icon = true,
}: {
  children: ReactNode;
  action?: string;
  variant?: "primary" | "outline" | "light";
  icon?: boolean;
}) {
  const open = usePreview();
  return (
    <button
      type="button"
      className={`button button-${variant}`}
      onClick={() =>
        open(action ?? (typeof children === "string" ? children : "UI preview"))
      }
    >
      {children}
      {icon && <ArrowUpRight size={16} aria-hidden="true" />}
    </button>
  );
}
