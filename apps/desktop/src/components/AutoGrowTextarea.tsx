import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type InputEvent,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";

type AutoGrowTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "rows"
> & {
  maxRows?: number;
};

function numberValue(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export function resizeTextareaToContent(
  textarea: HTMLTextAreaElement,
  maxRows: number,
) {
  const computed = window.getComputedStyle(textarea);
  const fontSize = numberValue(computed.fontSize);
  const lineHeight =
    numberValue(computed.lineHeight) || (fontSize ? fontSize * 1.45 : 24);
  const padding =
    numberValue(computed.paddingTop) + numberValue(computed.paddingBottom);
  const border =
    numberValue(computed.borderTopWidth) +
    numberValue(computed.borderBottomWidth);
  const minimumHeight = lineHeight + padding + border;
  const maximumHeight = lineHeight * maxRows + padding + border;

  textarea.style.height = "auto";
  const contentHeight = Math.max(textarea.scrollHeight + border, minimumHeight);
  textarea.style.height = `${Math.ceil(Math.min(contentHeight, maximumHeight))}px`;
  textarea.style.maxHeight = `${Math.ceil(maximumHeight)}px`;
  textarea.style.overflowY =
    contentHeight > maximumHeight + 0.5 ? "auto" : "hidden";
}

export const AutoGrowTextarea = forwardRef<
  HTMLTextAreaElement,
  AutoGrowTextareaProps
>(function AutoGrowTextarea(
  { maxRows = 5, onInput, value, ...props },
  forwardedRef,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const assignRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      setRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  useLayoutEffect(() => {
    if (textareaRef.current)
      resizeTextareaToContent(textareaRef.current, maxRows);
  }, [maxRows, value]);

  function handleInput(event: InputEvent<HTMLTextAreaElement>) {
    resizeTextareaToContent(event.currentTarget, maxRows);
    onInput?.(event);
  }

  return (
    <textarea
      {...props}
      onInput={handleInput}
      ref={assignRef}
      rows={1}
      value={value}
    />
  );
});
