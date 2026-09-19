import React from "react";

interface Props {
  children: React.ReactNode;
}
interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * App-wide error boundary. Catches uncaught render errors so a single failing
 * component shows a recoverable fallback instead of white-screening the whole
 * app. (The app previously had no boundary at all.)
 */
class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface in the console for debugging / Lovable capture.
    console.error("Uncaught render error:", error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 px-6 text-center bg-background">
        <span className="material-symbols-outlined text-5xl text-destructive">error</span>
        <h1 className="font-headline font-bold text-xl text-foreground">Something went wrong</h1>
        <p className="text-sm text-on-surface-variant max-w-md">
          The app hit an unexpected error and stopped rendering this view. Your data is safe — try again, or reload the page.
        </p>
        {this.state.error?.message && (
          <pre className="max-w-md overflow-auto rounded-lg bg-surface-container-high p-3 text-left text-[11px] text-on-surface-variant">
            {this.state.error.message}
          </pre>
        )}
        <div className="flex gap-2">
          <button
            onClick={this.handleReset}
            className="px-4 py-2 rounded-lg bg-primary-container text-on-primary-container text-sm font-semibold active:scale-95 transition-transform"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg bg-surface-container-high text-on-surface-variant text-sm font-semibold active:scale-95 transition-transform"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
