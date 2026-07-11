import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Button — shadcn primitive tuned to the TXL·Markets identity. Variants map to
 * the old hand-rolled classes:
 *   default  → .btn (outline)          primary → .btn-p (black ink)
 *   yes      → .btn-y (green outcome)  no      → .btn-n (red outcome)
 *   pill     → .pill (rounded filter)  pillOn  → .pill active (filled ink)
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-600 transition-[transform,background,opacity,color,border-color] active:translate-y-[0.5px] disabled:pointer-events-none disabled:opacity-45 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-[1.5px] border-[#2b2926] bg-surface text-ink hover:bg-[#f6f4ef]",
        primary:
          "border-[1.5px] border-ink bg-ink text-surface hover:bg-[#322e29]",
        yes: "border-[1.5px] border-yes bg-yes-btn-bg text-yes-strong hover:bg-[#ddf0e4]",
        no: "border-[1.5px] border-no bg-no-btn-bg text-no-strong hover:bg-[#f7dfe2]",
        pill: "rounded-full border-[1.5px] border-card-border bg-surface text-ink font-500 hover:border-muted",
        pillOn:
          "rounded-full border-[1.5px] border-ink bg-ink text-surface font-500",
        ghost: "hover:bg-black/[0.04] text-ink",
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        default: "h-auto rounded-lg px-4 py-[9px] text-[14px]",
        sm: "h-auto rounded-md px-3 py-1.5 text-[13px]",
        pill: "h-auto px-[14px] py-1.5 text-[13px]",
        icon: "size-9 rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
