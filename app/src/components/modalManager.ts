type ModalDocument = Pick<Document, "activeElement" | "body" | "addEventListener" | "removeEventListener"> & {
  getElementById(id: string): HTMLElement | null;
};

export type ModalEntry = {
  dialog: HTMLElement;
  onEscape: () => void;
};

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

/**
 * Keep keyboard handling and page inertness shared by all modal instances.
 * The manager is deliberately document-injectable so its state transitions can
 * be tested without a browser or a React renderer.
 */
export function createModalManager(doc: ModalDocument): {
  register: (entry: ModalEntry) => () => boolean;
  size: () => number;
} {
  const stack: ModalEntry[] = [];
  let previousOverflow: string | null = null;
  let previousRootInert: boolean | null = null;

  const onKeyDown = (event: KeyboardEvent) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    handleModalKeydown(event, top.dialog, doc.activeElement, top.onEscape);
  };

  const register = (entry: ModalEntry) => {
    if (stack.length === 0) {
      previousOverflow = doc.body.style.overflow;
      const root = doc.getElementById("root");
      previousRootInert = root?.inert ?? null;
      doc.body.style.overflow = "hidden";
      if (root) root.inert = true;
      doc.addEventListener("keydown", onKeyDown);
    }
    stack.push(entry);
    let registered = true;
    return () => {
      if (!registered) return false;
      registered = false;
      const index = stack.indexOf(entry);
      if (index === -1) return false;
      const wasTop = index === stack.length - 1;
      stack.splice(index, 1);
      if (stack.length === 0) {
        doc.removeEventListener("keydown", onKeyDown);
        doc.body.style.overflow = previousOverflow ?? "";
        const root = doc.getElementById("root");
        if (root && previousRootInert !== null) root.inert = previousRootInert;
        previousOverflow = null;
        previousRootInert = null;
      }
      return wasTop;
    };
  };

  return { register, size: () => stack.length };
}

export const modalManager: ReturnType<typeof createModalManager> = typeof document === "undefined"
  ? (null as unknown as ReturnType<typeof createModalManager>)
  : createModalManager(document);

export function handleModalKeydown(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  dialog: HTMLElement,
  activeElement: Element | null,
  onEscape: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    onEscape();
    return;
  }
  if (event.key !== "Tab") return;

  const controls = getFocusable(dialog);
  if (controls.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!dialog.contains(activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
