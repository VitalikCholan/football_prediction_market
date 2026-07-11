"use client";

/**
 * Global market-search state. The search input lives in the top nav (app shell)
 * while the market grid lives on the home page — two sibling subtrees under the
 * layout. A tiny client context connects them WITHOUT a URL round-trip: the
 * query filters an already-loaded list on the client, so there is no per-
 * keystroke server re-render / refetch (vercel: no waterfalls).
 */
import { createContext, useContext, useState } from "react";

interface SearchCtx {
  query: string;
  setQuery: (q: string) => void;
}

const Ctx = createContext<SearchCtx | null>(null);

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState("");
  return <Ctx.Provider value={{ query, setQuery }}>{children}</Ctx.Provider>;
}

export function useSearch(): SearchCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSearch must be used within <SearchProvider>");
  return ctx;
}
