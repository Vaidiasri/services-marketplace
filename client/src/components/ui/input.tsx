import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        // Translucent so the aurora shows through, but 60%+ so the value stays legible.
        // The focus ring is a real 2px ring, not just a glow: a soft shadow alone is not
        // a visible focus indicator for anyone relying on keyboard navigation.
        'flex h-10 w-full rounded-md border border-white/50 bg-white/60 px-3 py-2 text-sm backdrop-blur-md transition-all duration-200 placeholder:text-muted-foreground hover:border-white/70 hover:bg-white/70 focus-visible:border-primary/40 focus-visible:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10 dark:focus-visible:bg-white/10',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
