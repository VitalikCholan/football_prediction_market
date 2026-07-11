"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

/**
 * TabsList — two visual modes:
 *  - segmented (default): the control on a skeleton track (Buy/Sell in 1d).
 *  - pills: free-standing pill toggles (Open/History/Claims in 1e).
 */
function TabsList({
  className,
  variant = "segmented",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  variant?: "segmented" | "pills";
}) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex items-center",
        variant === "segmented"
          ? "w-full gap-1 rounded-lg bg-skeleton p-1"
          : "flex-wrap gap-1.5",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  variant = "segmented",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  variant?: "segmented" | "pills";
}) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap font-600 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        variant === "segmented"
          ? "flex-1 rounded-md py-1.5 text-[13px] text-muted data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm"
          : "rounded-full border-[1.5px] border-card-border bg-surface px-[14px] py-1.5 text-[13px] font-500 text-ink hover:border-muted data-[state=active]:border-ink data-[state=active]:bg-ink data-[state=active]:text-surface",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
