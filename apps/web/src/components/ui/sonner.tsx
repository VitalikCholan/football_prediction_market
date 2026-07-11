"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * Sonner toast host, themed to the TXL surface. Mounted once by ToastProvider;
 * toasts are pushed imperatively via `useToast().push(...)` (see toast.tsx),
 * preserving the original API surface.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={16}
      toastOptions={{
        unstyled: false,
        classNames: {
          toast:
            "!rounded-xl !border-[1.5px] !border-card-border !bg-surface !text-ink !shadow-[0_2px_6px_rgba(0,0,0,0.05)] !gap-3 !px-4 !py-3 !font-sans",
          title: "!text-[13px] !font-600",
        },
      }}
      style={
        {
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--ink)",
          "--normal-border": "var(--card-border)",
        } as React.CSSProperties
      }
    />
  );
}
