import { type ReactNode, useState } from 'react';
import { Button, type ButtonProps } from './ui/button';

/**
 * A button that asks for confirmation in place, instead of a modal dialog (modal scroll locking
 * injects inline styles, which the app's Content Security Policy blocks).
 */
export function ConfirmButton({
  children,
  confirmLabel,
  question,
  onConfirm,
  pending,
  ...props
}: Omit<ButtonProps, 'onClick'> & {
  confirmLabel: string;
  question: ReactNode;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button {...props} onClick={() => setAsking(true)}>
        {children}
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground" role="status">
        {question}
      </span>
      <Button
        size="sm"
        variant={props.variant === 'outline' ? 'destructive' : (props.variant ?? 'destructive')}
        pending={pending}
        onClick={() => {
          onConfirm();
          setAsking(false);
        }}
        autoFocus
      >
        {confirmLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}
