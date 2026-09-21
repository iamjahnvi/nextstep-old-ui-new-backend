import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// Status badge for exam application state. The visual treatment lives in
// MainPage.css (.main-pill and its modifiers), so the NextStep visual
// identity stays the source of truth — this component only maps the
// three discovery states to those brand classes.
const badgeVariants = cva("main-pill", {
  variants: {
    variant: {
      open: "main-pill--open",
      soon: "main-pill--soon",
      closed: "main-pill--closed",
    },
  },
  defaultVariants: {
    variant: "closed",
  },
})

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
