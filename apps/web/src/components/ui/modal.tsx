"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

// SSR-safe "are we on the client yet" flag without setState-in-effect: the
// server snapshot is false, the client snapshot true, so the first client
// commit flips it. No subscription needed (mount status never changes after).
const noopSubscribe = () => () => {};

/** Minimal accessible modal: overlay + centered card, Escape to close. */
export function Modal({
  open,
  onClose,
  children,
  labelledBy,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  labelledBy?: string;
  width?: number;
}) {
  // Portal target — mounted client-side only (SSR-safe).
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  // Portal to <body> so the fixed overlay centers against the viewport, not a
  // transformed/blurred ancestor (e.g. the sticky nav creates a containing
  // block that would otherwise pin `fixed` to the header).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="scr reveal w-full p-6"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
