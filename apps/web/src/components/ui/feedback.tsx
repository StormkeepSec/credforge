import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

const alertVariants = cva(
  'flex gap-3 rounded-lg border p-4 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        info: 'border-border bg-muted text-foreground [&>svg]:text-link',
        success: 'border-ok/40 bg-ok/10 text-foreground [&>svg]:text-ok',
        warning: 'border-caution/40 bg-caution/10 text-foreground [&>svg]:text-caution',
        error: 'border-destructive/40 bg-destructive/10 text-foreground [&>svg]:text-destructive',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

const icons = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle };

interface AlertProps
  extends Omit<ComponentProps<'div'>, 'title'>,
    VariantProps<typeof alertVariants> {
  title?: ReactNode;
}

/** A message box. Errors are announced to screen readers as they appear. */
export function Alert({ className, variant, title, children, ...props }: AlertProps) {
  const Icon = icons[variant ?? 'info'];
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <Icon aria-hidden="true" />
      <div className="grid gap-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && (
          <div className="text-muted-foreground [&_a]:text-link [&_a]:underline">{children}</div>
        )}
      </div>
    </div>
  );
}

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-muted text-foreground',
        success: 'border-ok/40 bg-ok/10 text-foreground',
        warning: 'border-caution/50 bg-caution/10 text-foreground',
        danger: 'border-destructive/50 bg-destructive/10 text-foreground',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label}…
    </div>
  );
}
