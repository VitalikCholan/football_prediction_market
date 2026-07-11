import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Badge — shadcn primitive tuned to the old `.tag` family. Variants cover the
 * competition tag (default), live tag, resolved/closed/upcoming states, the
 * plain score chip, and the verified pill.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[5px] px-[7px] py-[2px] text-[10px] font-600 uppercase tracking-[0.06em] whitespace-nowrap w-fit [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-tag-bg text-link",
        live: "bg-live-bg text-live-fg",
        resolved: "bg-verified-bg text-verified-fg",
        muted: "bg-skeleton text-muted",
        warning: "bg-[#fff5e6] text-[#b7791f]",
        score: "bg-skeleton text-ink",
        verified:
          "gap-[5px] rounded-[6px] border border-verified-border bg-verified-bg px-2 py-[3px] text-[11px] normal-case tracking-normal text-verified-fg",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
