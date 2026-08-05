import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn's class helper. twMerge is the part that matters: it resolves conflicting
 * Tailwind utilities so a caller's `className` can override a component's defaults
 * instead of both landing in the class list and letting stylesheet order decide.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
