import * as React from "react"
import { cn } from "cn"

// Loading placeholder primitive. The shimmer treatment lives in
// MainPage.css (.main-skeleton). Blocks are decorative and hidden from
// assistive tech — the labelled container announces loading instead.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("main-skeleton", className)}
      {...props}
    />
  )
}

export { Skeleton }
