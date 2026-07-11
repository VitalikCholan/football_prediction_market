"use client";

import { createContext, useContext, useMemo } from "react";
import { toast as sonnerToast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

interface ToastInput {
  title: string;
  href?: string;
  hrefLabel?: string;
}

const ToastCtx = createContext<{ push: (t: ToastInput) => void }>({
  push: () => {},
});

export function useToast() {
  return useContext(ToastCtx);
}

/**
 * Toast provider — same API surface as before (`useToast().push({ title,
 * href, hrefLabel })`) but backed by sonner. Renders the signature `◆`
 * verified glyph + title + optional "View tx ↗" link, bottom-right.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo(
    () => ({
      push: (t: ToastInput) =>
        sonnerToast.custom(
          () => (
            <div className="flex items-center gap-3">
              <span className="text-verified-fg" aria-hidden>
                ◆
              </span>
              <span className="text-[13px] font-600">{t.title}</span>
              {t.href ? (
                <a
                  className="text-link text-[12px] font-600 no-underline hover:underline"
                  href={t.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.hrefLabel ?? "View ↗"}
                </a>
              ) : null}
            </div>
          ),
          { duration: 5000 },
        ),
    }),
    [],
  );

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <Toaster />
    </ToastCtx.Provider>
  );
}
