import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { FilePreviewLoading } from "./FilePreviewFeedback";
import { LoadingStrip } from "../../components/LoadingStrip";

export function WorkspaceFileWebPreview(props: { readonly uri: string | null }) {
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  if (props.uri === null) {
    return <FilePreviewLoading message="Preparing preview..." background="card" />;
  }

  return (
    <View className="relative flex-1 bg-card">
      {loadProgress > 0 && loadProgress < 1 ? <LoadingStrip progress={loadProgress} /> : null}
      {loadError ? (
        <View className="border-b border-border bg-card px-4 py-2">
          <Text className="text-xs font-t3-bold text-foreground">Preview failed</Text>
          <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">{loadError}</Text>
        </View>
      ) : null}
      <WebView
        source={{ uri: props.uri }}
        originWhitelist={["*"]}
        allowsBackForwardNavigationGestures
        allowsFullscreenVideo
        setSupportMultipleWindows={false}
        startInLoadingState
        onLoadProgress={(event) => {
          setLoadProgress(event.nativeEvent.progress);
        }}
        onLoadStart={() => {
          setLoadProgress(0.05);
          setLoadError(null);
        }}
        onLoadEnd={() => {
          setLoadProgress(0);
        }}
        onError={(event) => {
          setLoadProgress(0);
          setLoadError(event.nativeEvent.description || "The file could not be rendered.");
        }}
        renderLoading={() => (
          <View className="absolute inset-0 items-center justify-center bg-card">
            <AppActivityIndicator />
          </View>
        )}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}

function svgViewerHtml(uri: string): string {
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=10">
<style>
  html, body { margin: 0; background: #fff; }
  img { display: block; width: 100%; height: auto; }
</style></head>
<body><img alt="" src=${JSON.stringify(uri)}></body></html>`;
}

/**
 * SVG preview (sidebar fork). The server sends SVG with a sandboxing CSP that
 * leaves Android's WebView blank when the file is the document, so the image
 * is shown from a page of our own, where pinch-zoom re-draws it as vectors.
 */
export function WorkspaceFileSvgPreview(props: { readonly uri: string | null }) {
  const origin = props.uri?.match(/^https?:\/\/[^/]+/)?.[0] ?? null;
  if (props.uri === null || origin === null) {
    return <FilePreviewLoading message="Preparing preview..." background="card" />;
  }
  return (
    <WebView
      source={{ html: svgViewerHtml(props.uri), baseUrl: origin }}
      originWhitelist={["*"]}
      setSupportMultipleWindows={false}
      style={{ flex: 1, backgroundColor: "transparent" }}
    />
  );
}
