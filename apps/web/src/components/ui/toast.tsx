"use client";

import { createContext, useCallback, useContext, useState } from "react";

interface Toast {
  id: number;
  title: string;
  href?: string;
  hrefLabel?: string;
}

const ToastCtx = createContext<{
  push: (t: Omit<Toast, "id">) => void;
}>({ push: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

/** Minimal toast host. Auto-dismisses; optional "View tx ↗" link. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((x) => x.id !== id)),
      5000,
    );
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div key={t.id} className="scr slide-in flex items-center gap-3 px-4 py-3">
            <span className="text-verified-fg" aria-hidden>
              ◆
            </span>
            <span className="text-[13px] font-600">{t.title}</span>
            {t.href ? (
              <a
                className="link text-[12px] font-600 no-underline"
                href={t.href}
                target="_blank"
                rel="noreferrer"
              >
                {t.hrefLabel ?? "View ↗"}
              </a>
            ) : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
