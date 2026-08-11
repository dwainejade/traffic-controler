import { useEffect, useState } from "react";

/**
 * The one breakpoint the UI has.
 *
 * Below it there is no room for panels in three corners at once, so the HUD
 * collapses to a bottom bar plus two sheets. It is a media query rather than a
 * touch test on purpose: a narrow desktop window has the same problem, and a
 * touchscreen laptop does not.
 */
export const MOBILE_QUERY = "(max-width: 760px)";

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    /*
     * And on resize, which is belt and braces: an embedded pane that starts at
     * zero width and is then given a real one leaves the query event
     * undelivered, and the HUD sits in its phone layout on a full-size window
     * until something else re-renders it.
     */
    window.addEventListener("resize", onChange);
    onChange();
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, []);

  return mobile;
}
