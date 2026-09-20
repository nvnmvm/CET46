import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/** Render modal layers outside page stacking contexts such as `.home-page`. */
export default function ModalPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
