import { Label as LabelPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';
import { cn } from '../../lib/utils';

const control =
  'w-full rounded-md border border-input bg-card px-3 text-sm text-card-foreground placeholder:text-placeholder focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive';

/** Read-only text stays at full contrast and focusable (unlike `disabled`), on a muted fill. */
const textControl = 'read-only:border-border read-only:bg-muted';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, textControl, 'h-10 py-2', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(control, textControl, 'min-h-24 py-2', className)} {...props} />;
}

/** A native select: accessible everywhere and needs no scroll locking (which the CSP blocks). */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(control, 'h-10 py-2 pr-8', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-sm leading-none font-semibold text-foreground', className)}
      {...props}
    />
  );
}

interface FieldProps {
  label: ReactNode;
  /** Hint under the label. */
  description?: ReactNode;
  error?: string;
  className?: string;
  /** Renders the control with the ids it needs for its label, hint and error. */
  children: (props: {
    id: string;
    'aria-invalid'?: true;
    'aria-describedby'?: string;
  }) => ReactNode;
}

/** A labelled form control with an optional hint and error message. */
export function Field({ label, description, error, className, children }: FieldProps) {
  const id = useId();
  const describedBy = [description && `${id}-hint`, error && `${id}-error`]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cn('grid gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {description && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {children({
        id,
        ...(error && { 'aria-invalid': true as const }),
        ...(describedBy && { 'aria-describedby': describedBy }),
      })}
      {error && (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
