import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button, type ButtonProps } from './ui/button';

/**
 * A button that asks for confirmation in place, instead of a modal dialog (modal scroll locking
 * injects inline styles, which the app's Content Security Policy blocks). Focus moves to the
 * confirm button while asking, and back to this button when the question closes.
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
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!asking && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [asking]);

  function stopAsking() {
    restoreFocus.current = true;
    setAsking(false);
  }

  if (!asking) {
    return (
      <Button {...props} ref={trigger} onClick={() => setAsking(true)}>
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
          stopAsking();
        }}
        autoFocus
      >
        {confirmLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={stopAsking}>
        Cancel
      </Button>
    </span>
  );
}
