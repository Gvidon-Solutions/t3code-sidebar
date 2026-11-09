import { Button } from "../ui/button";
import { StandalonePage } from "../ui/standalone-page";
import {
  desktopBundledRetryUrl,
  desktopFallbackServerLabel,
  type DesktopBundledFallback,
} from "./desktopBundledFallback";

/** The desktop shell's bundled UI when the selected server does not answer. */
export function DesktopBundledOffline(props: {
  readonly fallback: DesktopBundledFallback;
  /** Where Retry navigates; defaults to asking the shell for the server UI again. */
  readonly retryHref?: string;
}) {
  const label = desktopFallbackServerLabel(props.fallback.server);
  const retryHref = props.retryHref ?? desktopBundledRetryUrl(window.location.href);
  return (
    <StandalonePage>
      <div className="flex flex-col gap-3">
        <h1 className="text-xl leading-tight font-semibold">Can't reach {label}</h1>
        <p className="text-sm text-muted-foreground">
          The desktop app is showing its bundled UI. Start {label} or check the connection, then
          retry.
        </p>
        <div>
          <Button render={<a href={retryHref} />} className="inline-flex">
            Retry
          </Button>
        </div>
      </div>
    </StandalonePage>
  );
}
