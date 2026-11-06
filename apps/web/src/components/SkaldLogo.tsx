import lightLogoUrl from "../../../../assets/skald/skald-code-logo-horizontal.svg";
import darkLogoUrl from "../../../../assets/skald/skald-code-logo-horizontal-on-dark.svg";

import { cn } from "~/lib/utils";

export function SkaldLogo(props: { readonly className?: string; readonly onBackdrop?: boolean }) {
  return (
    <span
      role="img"
      aria-label="Skald Code"
      className={cn("inline-flex shrink-0", props.className)}
    >
      {props.onBackdrop ? (
        <img src={darkLogoUrl} alt="" className="h-full w-auto" />
      ) : (
        <>
          <img src={lightLogoUrl} alt="" className="h-full w-auto dark:hidden" />
          <img src={darkLogoUrl} alt="" className="hidden h-full w-auto dark:block" />
        </>
      )}
    </span>
  );
}
