import { Button } from "../ui/button";
import { StandalonePage } from "../ui/standalone-page";
import {
  desktopBundledLocalSettingsUrl,
  desktopBundledRetryUrl,
  desktopFallbackServerAddress,
  desktopFallbackServerLabel,
  type DesktopBundledFallback,
} from "./desktopBundledFallback";

/** The desktop shell's bundled UI when the selected server does not answer. */
export function DesktopBundledOffline(props: {
  readonly fallback: DesktopBundledFallback;
  /** Where Retry navigates; defaults to asking the shell for the server UI again. */
  readonly retryHref?: string;
  /** Where "Choose another server" goes; defaults to the bundled Settings › Connections. */
  readonly chooseServerHref?: string;
}) {
  const label = desktopFallbackServerLabel(props.fallback);
  const address = desktopFallbackServerAddress(props.fallback);
  const retryHref = props.retryHref ?? desktopBundledRetryUrl(window.location.href);
  const chooseServerHref =
    props.chooseServerHref ?? desktopBundledLocalSettingsUrl(window.location.href);
  return (
    <StandalonePage>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl leading-tight font-semibold">Can't reach {label}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            T3 Code can't reach {label}. Make sure it is running, then try again.
          </p>
        </div>
        {address === null ? null : <p className="text-xs text-muted-foreground/70">{address}</p>}
        <div className="flex flex-wrap gap-2">
          <Button render={<a href={retryHref} />} className="inline-flex">
            Retry
          </Button>
          <Button variant="outline" render={<a href={chooseServerHref} />} className="inline-flex">
            Choose another server
          </Button>
        </div>
      </div>
    </StandalonePage>
  );
}
