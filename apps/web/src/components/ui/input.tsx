import * as React from "react";

import { cn } from "@/lib/utils";

/** Input — shadcn primitive tuned to the old `.field` look. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex w-full rounded-[9px] border-[1.5px] border-box-border bg-surface px-3 py-[9px] text-[14px] text-ink",
        "placeholder:text-muted",
        "outline-none transition-colors focus-visible:border-link",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
